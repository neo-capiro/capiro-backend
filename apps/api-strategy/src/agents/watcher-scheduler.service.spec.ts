import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { WatcherSchedulerService, fingerprintCalendars } from './watcher-scheduler.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReferenceCalendars, ReferenceRow } from '../reference/reference.service.js';

/*
 * WatcherSchedulerService against a fake withSystem + fake tx (same in-memory
 * pattern as the other agent specs). The fake claim implements the SEMANTICS
 * of the atomic UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED): it
 * filters due active-cadence missions, bumps nextRunAt SYNCHRONOUSLY (so an
 * overlapping pass sees the row as no longer due — claim-once, exactly what
 * SKIP LOCKED + the in-statement bump give two pods), and returns the claimed
 * rows with their PRE-bump dueAt.
 */

const T = 'tenant-1';
const DAY = 86_400_000;

/** The scheduler's day bucket: the UTC day of the pre-bump dueAt. */
const day = (d: Date) => d.toISOString().slice(0, 10);

interface MissionRec {
  id: string;
  tenantId: string;
  strategyId: string | null;
  state: string;
  cadence: string | null;
  nextRunAt: Date | null;
}
interface RunRec {
  id: string;
  state: string;
  idempotencyKey: string;
  missionId?: string;
  findings?: unknown;
  createdAt?: Date;
}

/** ReferenceRow fixture — ids/tone/position deliberately non-substantive. */
const refRow = (
  kind: string,
  label: string,
  fy: number | null,
  startsOn: string | null,
  endsOn: string | null,
  extra: Partial<Pick<ReferenceRow, 'id' | 'tone' | 'position'>> = {},
): ReferenceRow => ({
  id: extra.id ?? `${kind}:${label}`,
  kind,
  label,
  fy,
  startsOn: startsOn ? new Date(`${startsOn}T00:00:00.000Z`) : null,
  endsOn: endsOn ? new Date(`${endsOn}T00:00:00.000Z`) : null,
  tone: extra.tone ?? null,
  position: extra.position ?? 0,
});

/** A small non-empty merged-calendars fixture (ReferenceService.getCalendars shape). */
const makeCalendars = (): ReferenceCalendars => ({
  congress: [
    refRow('congress_milestone', 'HASC markup', 2027, '2026-04-29', null),
    refRow('congress_milestone', 'SASC markup', 2027, '2026-05-06', null),
  ],
  ppbeLanes: [refRow('ppbe_lane_bar', 'POM build', 2029, '2026-01-15', '2026-08-01')],
  ppbeCurrentPhases: [refRow('ppbe_current_phase', 'Execution FY26', 2026, null, null)],
  source: { congress: 'baseline', ppbeLanes: 'baseline', ppbeCurrentPhases: 'baseline' },
});

function makeHarness() {
  const missions: MissionRec[] = [];
  const runs: RunRec[] = [];

  // Semantics of the scheduler's single withSystem raw statement (see header).
  const claim = () => {
    const now = new Date();
    const due = missions
      .filter(
        (m) =>
          m.state === 'active' && m.cadence !== null && m.nextRunAt !== null && m.nextRunAt <= now,
      )
      .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime())
      .slice(0, 100);
    return due.map((m) => {
      const dueAt = m.nextRunAt!;
      // Mirrors the SQL bump: advance the PRE-bump nextRunAt by whole cadence
      // steps to the first occurrence strictly after now (schedule-anchored —
      // claim lag never drifts the phase; missed occurrences are skipped).
      const cadenceMs = (m.cadence === 'weekly' ? 7 : 1) * DAY;
      const steps = Math.floor((now.getTime() - dueAt.getTime()) / cadenceMs) + 1;
      m.nextRunAt = new Date(dueAt.getTime() + steps * cadenceMs);
      return {
        id: m.id,
        tenantId: m.tenantId,
        strategyId: m.strategyId,
        cadence: m.cadence!,
        dueAt,
      };
    });
  };

  const withSystem = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: async () => claim() }),
  );
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      spAgentRun: {
        findFirst: async ({ where }: { where: { idempotencyKey: string } }) =>
          runs.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null,
        // lastRecordedFingerprint's bounded scan: mission's other runs, newest
        // first, findings only.
        findMany: async ({
          where,
          take,
        }: {
          where: { missionId: string; id?: { not?: string } };
          take?: number;
        }) =>
          runs
            .filter(
              (r) =>
                (r.missionId === undefined || r.missionId === where.missionId) &&
                r.id !== where.id?.not,
            )
            .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
            .slice(0, take ?? runs.length)
            .map((r) => ({ findings: r.findings ?? null })),
      },
    }),
  );
  const prisma = { withSystem, withTenant } as unknown as PrismaService;

  const runCheckNow = jest.fn(
    async (_tenantId: string, _userId: string | null, _missionId: string, _opts: unknown) =>
      undefined as unknown,
  );
  const createRun = jest.fn(
    async (_tenantId: string, _userId: string | null, _missionId: string, _dto: unknown) =>
      ({ id: 'R-firm', state: 'queued' }) as unknown,
  );
  const transition = jest.fn(
    async (_tenantId: string, _userId: string | null, _runId: string, _dto: unknown) =>
      undefined as unknown,
  );
  const isAgenticFlagEnabled = jest.fn(async (_tenantId: string, _flag: string) => true);
  // Merged reference calendars (ReferenceService.getCalendars) — empty
  // baseline by default; change-detection tests mockResolvedValue a fixture.
  const getCalendars = jest.fn(
    async (_tenantId: string): Promise<ReferenceCalendars> => ({
      congress: [],
      ppbeLanes: [],
      ppbeCurrentPhases: [],
      source: {},
    }),
  );

  const svc = new WatcherSchedulerService(
    prisma,
    { runCheckNow } as never,
    { createRun, transition } as never,
    { isAgenticFlagEnabled } as never,
    { getCalendars } as never,
  );
  return {
    svc,
    missions,
    runs,
    withSystem,
    withTenant,
    runCheckNow,
    createRun,
    transition,
    isAgenticFlagEnabled,
    getCalendars,
  };
}

const ENV_KEYS = [
  'STRATEGY_AGENTS_ENABLED',
  'STRATEGY_WATCHER_SCHEDULER',
  'STRATEGY_WATCHER_POLL_MS',
] as const;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

describe('WatcherSchedulerService.tickOnce — claim semantics', () => {
  it('claims ONLY due active cadence missions and runs each as system with a bucketed idempotency key', async () => {
    const h = makeHarness();
    const due1 = new Date(Date.now() - 60_000);
    const due2 = new Date(Date.now() - 30_000);
    h.missions.push(
      {
        id: 'M1',
        tenantId: T,
        strategyId: 'S1',
        state: 'active',
        cadence: 'daily',
        nextRunAt: due1,
      },
      {
        id: 'M2',
        tenantId: 't2',
        strategyId: 'S2',
        state: 'active',
        cadence: 'weekly',
        nextRunAt: due2,
      },
      // Every non-claimable shape:
      { id: 'M3', tenantId: T, strategyId: 'S1', state: 'active', cadence: null, nextRunAt: due1 }, // manual-only
      {
        id: 'M4',
        tenantId: T,
        strategyId: 'S1',
        state: 'paused',
        cadence: 'daily',
        nextRunAt: due1,
      }, // not active
      {
        id: 'M5',
        tenantId: T,
        strategyId: 'S1',
        state: 'active',
        cadence: 'daily',
        nextRunAt: new Date(Date.now() + DAY),
      }, // future
      {
        id: 'M6',
        tenantId: T,
        strategyId: 'S1',
        state: 'active',
        cadence: 'daily',
        nextRunAt: null,
      }, // never scheduled
    );

    const res = await h.svc.tickOnce();

    expect(res).toEqual({ claimed: 2, succeeded: 2, failed: 0, skipped: 0 });
    expect(h.runCheckNow).toHaveBeenCalledTimes(2);
    // userId null => system-triggered; key = sched:<mission>:<UTC day of the
    // pre-bump dueAt> — DAY granularity, so intra-day re-triggers coalesce.
    expect(h.runCheckNow).toHaveBeenCalledWith(T, null, 'M1', {
      idempotencyKey: `sched:M1:${day(due1)}`,
      trigger: 'scheduled',
    });
    expect(h.runCheckNow).toHaveBeenCalledWith('t2', null, 'M2', {
      idempotencyKey: `sched:M2:${day(due2)}`,
      trigger: 'scheduled',
    });
    // Cross-tenant claim runs inside withSystem (never a tenant scope).
    expect(h.withSystem).toHaveBeenCalledTimes(1);
  });

  it('bumps nextRunAt by whole cadence steps FROM the schedule (skips missed occurrences, never lands in the past)', async () => {
    const h = makeHarness();
    const start = Date.now();
    // M1 three days overdue (downtime): fires ONCE, then resumes its ORIGINAL
    // phase — dueAt + 4d, the first on-schedule occurrence after now. NOT
    // now + 1d (claim-time re-anchor) and NOT dueAt + 1d (still in the past
    // => catch-up storm).
    const m1Due = new Date(start - 3 * DAY);
    const m2Due = new Date(start - 1000);
    h.missions.push(
      {
        id: 'M1',
        tenantId: T,
        strategyId: 'S1',
        state: 'active',
        cadence: 'daily',
        nextRunAt: m1Due,
      },
      {
        id: 'M2',
        tenantId: T,
        strategyId: 'S2',
        state: 'active',
        cadence: 'weekly',
        nextRunAt: m2Due,
      },
    );

    await h.svc.tickOnce();

    const m1 = h.missions.find((m) => m.id === 'M1')!;
    const m2 = h.missions.find((m) => m.id === 'M2')!;
    expect(m1.nextRunAt!.getTime()).toBe(m1Due.getTime() + 4 * DAY);
    expect(m2.nextRunAt!.getTime()).toBe(m2Due.getTime() + 7 * DAY);
    // Both strictly in the future (claiming requires nextRunAt <= now, so the
    // bump can never land at-or-before now).
    expect(m1.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(m2.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    // Claim-once: the bump makes the missions no longer due.
    const again = await h.svc.tickOnce();
    expect(again.claimed).toBe(0);
    expect(h.runCheckNow).toHaveBeenCalledTimes(2);
  });

  it('claim lag never drifts the schedule anchor (a 9am mission claimed 47s late stays a 9am mission)', async () => {
    const h = makeHarness();
    // 47s of poll lag between the scheduled time and the claim — the shape
    // that made the old GREATEST(dueAt, now()) + cadence bump drift every
    // occurrence forward by the lag (and accumulate across occurrences).
    const due = new Date(Date.now() - 47_000);
    h.missions.push({
      id: 'M1',
      tenantId: T,
      strategyId: 'S1',
      state: 'active',
      cadence: 'daily',
      nextRunAt: due,
    });

    await h.svc.tickOnce();

    // EXACTLY dueAt + 1d — the lag is absorbed, not baked into the phase.
    expect(h.missions[0]!.nextRunAt!.getTime()).toBe(due.getTime() + DAY);
  });

  it('overlapping passes never double-run a mission (SKIP LOCKED simulated as claim-once)', async () => {
    const h = makeHarness();
    h.missions.push(
      {
        id: 'M1',
        tenantId: T,
        strategyId: 'S1',
        state: 'active',
        cadence: 'daily',
        nextRunAt: new Date(Date.now() - 1000),
      },
      {
        id: 'M2',
        tenantId: T,
        strategyId: 'S2',
        state: 'active',
        cadence: 'daily',
        nextRunAt: new Date(Date.now() - 2000),
      },
    );

    const [a, b] = await Promise.all([h.svc.tickOnce(), h.svc.tickOnce()]);

    // Both passes ran, but each mission was claimed by exactly one of them.
    expect(a.claimed + b.claimed).toBe(2);
    expect(h.runCheckNow).toHaveBeenCalledTimes(2);
    const missionIds = h.runCheckNow.mock.calls.map((c) => c[2]).sort();
    expect(missionIds).toEqual(['M1', 'M2']);
  });

  it('outbox bring-forwards within one day COALESCE onto one bucket (same key each poll — no run-per-poll storm)', async () => {
    const h = makeHarness();
    const due = new Date(Date.now() - 1000);
    h.missions.push({
      id: 'M1',
      tenantId: T,
      strategyId: 'S1',
      state: 'active',
      cadence: 'daily',
      nextRunAt: due,
    });

    await h.svc.tickOnce(); // poll 1 claims the due occurrence

    // Outbox-consumer shape: a later plan edit brings the mission forward
    // again the SAME day (nextRunAt = now()) and the next poll re-claims it.
    h.missions[0]!.nextRunAt = new Date();
    await h.svc.tickOnce(); // poll 2

    expect(h.runCheckNow).toHaveBeenCalledTimes(2);
    const keys = h.runCheckNow.mock.calls.map(
      (c) => (c[3] as { idempotencyKey: string }).idempotencyKey,
    );
    // SAME day-bucketed key both times: RunsService dedupes on it, so the
    // second poll REFRESHES the day's existing run in place instead of minting
    // another ready_for_review row per poll (the editing-session storm).
    expect(keys[0]).toBe(`sched:M1:${day(due)}`);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('WatcherSchedulerService — per-tenant flag gate', () => {
  it('skips a claimed mission QUIETLY when the tenant strategyWatcher flag is off (no run, no failure)', async () => {
    const h = makeHarness();
    h.isAgenticFlagEnabled.mockResolvedValue(false);
    h.missions.push(
      {
        id: 'M1',
        tenantId: T,
        strategyId: 'S1',
        state: 'active',
        cadence: 'daily',
        nextRunAt: new Date(Date.now() - 1000),
      },
      {
        id: 'M2',
        tenantId: T,
        strategyId: null,
        state: 'active',
        cadence: 'daily',
        nextRunAt: new Date(Date.now() - 2000),
      },
    );

    const res = await h.svc.tickOnce();

    expect(res).toEqual({ claimed: 2, succeeded: 0, failed: 0, skipped: 2 });
    expect(h.runCheckNow).not.toHaveBeenCalled();
    expect(h.createRun).not.toHaveBeenCalled();
    // The claim still bumped nextRunAt — the flag is re-checked next occurrence.
    expect(h.missions[0]!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('WatcherSchedulerService — firm-level calendar mission (change-detected placeholder)', () => {
  it('NO baseline yet (first occurrence): one scheduled run, planning -> ready_for_review, single critical firmLevel finding + fingerprint recorded', async () => {
    const h = makeHarness();
    const due = new Date(Date.now() - 1000);
    h.missions.push({
      id: 'MF',
      tenantId: T,
      strategyId: null,
      state: 'active',
      cadence: 'weekly',
      nextRunAt: due,
    });

    const res = await h.svc.tickOnce();

    expect(res).toEqual({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    // Firm missions do NOT go through the strategy-scoped runCheckNow (it 400s
    // on strategyId null) — the scheduler owns the placeholder path.
    expect(h.runCheckNow).not.toHaveBeenCalled();
    expect(h.createRun).toHaveBeenCalledWith(T, null, 'MF', {
      trigger: 'scheduled',
      idempotencyKey: `sched:MF:${day(due)}`,
    });
    // queued -> planning -> ready_for_review (the Stage F check-run shape).
    expect(h.transition).toHaveBeenNthCalledWith(1, T, null, 'R-firm', { to: 'planning' });
    expect(h.transition).toHaveBeenNthCalledWith(
      2,
      T,
      null,
      'R-firm',
      expect.objectContaining({
        to: 'ready_for_review',
        findings: expect.objectContaining({
          findings: [
            expect.objectContaining({ code: 'firm-calendar-review', severity: 'critical' }),
          ],
          // The RiskRouter firmLevel hard rule, recorded on the run.
          riskClassification: {
            risk: 'critical',
            autoApplyEligible: false,
            requiresImpactSummary: true,
          },
          // The baseline the NEXT occurrence's change detection compares to.
          calendarFingerprint: expect.any(String),
        }),
      }),
    );
  });

  it('an UNCHANGED calendar creates NO noise: findings [] + fingerprint only — no critical finding, no riskClassification (the daily-drumbeat regression)', async () => {
    const h = makeHarness();
    const cal = makeCalendars();
    h.getCalendars.mockResolvedValue(cal);
    h.missions.push({
      id: 'MF',
      tenantId: T,
      strategyId: null,
      state: 'active',
      cadence: 'daily',
      nextRunAt: new Date(Date.now() - 1000),
    });
    // Yesterday's occurrence already recorded the fingerprint of the SAME calendars.
    h.runs.push({
      id: 'R-prev',
      state: 'ready_for_review',
      idempotencyKey: 'sched:MF:yesterday',
      missionId: 'MF',
      createdAt: new Date(Date.now() - DAY),
      findings: {
        findings: [{ code: 'firm-calendar-review', severity: 'critical' }],
        calendarFingerprint: fingerprintCalendars(cal),
      },
    });

    const res = await h.svc.tickOnce();

    expect(res).toEqual({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    const review = h.transition.mock.calls.find(
      (c) => (c[3] as { to: string }).to === 'ready_for_review',
    )!;
    // The run row IS the record: exactly findings [] + the (unchanged)
    // fingerprint — a run that detected nothing emits NOTHING for a reviewer.
    expect(review[3]).toEqual({
      to: 'ready_for_review',
      findings: { findings: [], calendarFingerprint: fingerprintCalendars(cal) },
    });
  });

  it('a CHANGED calendar re-emits the critical finding and records the NEW fingerprint', async () => {
    const h = makeHarness();
    const cal = makeCalendars();
    h.getCalendars.mockResolvedValue(cal);
    // The recorded baseline was taken before HASC markup moved by two weeks.
    const before = makeCalendars();
    before.congress[0] = { ...before.congress[0]!, startsOn: new Date('2026-04-15T00:00:00.000Z') };
    h.missions.push({
      id: 'MF',
      tenantId: T,
      strategyId: null,
      state: 'active',
      cadence: 'daily',
      nextRunAt: new Date(Date.now() - 1000),
    });
    h.runs.push({
      id: 'R-prev',
      state: 'completed',
      idempotencyKey: 'sched:MF:yesterday',
      missionId: 'MF',
      createdAt: new Date(Date.now() - DAY),
      findings: { findings: [], calendarFingerprint: fingerprintCalendars(before) },
    });

    await h.svc.tickOnce();

    const review = h.transition.mock.calls.find(
      (c) => (c[3] as { to: string }).to === 'ready_for_review',
    )!;
    const dto = review[3] as {
      findings: { findings: unknown[]; riskClassification: unknown; calendarFingerprint: string };
    };
    expect(dto.findings.findings).toEqual([
      expect.objectContaining({ code: 'firm-calendar-review', severity: 'critical' }),
    ]);
    expect(dto.findings.riskClassification).toEqual({
      risk: 'critical',
      autoApplyEligible: false,
      requiresImpactSummary: true,
    });
    expect(dto.findings.calendarFingerprint).toBe(fingerprintCalendars(cal));
  });

  it('a failed occurrence in between does NOT erase the baseline (bounded scan walks past fingerprint-less runs)', async () => {
    const h = makeHarness();
    const cal = makeCalendars();
    h.getCalendars.mockResolvedValue(cal);
    h.missions.push({
      id: 'MF',
      tenantId: T,
      strategyId: null,
      state: 'active',
      cadence: 'daily',
      nextRunAt: new Date(Date.now() - 1000),
    });
    h.runs.push(
      // Newest prior run failed before recording anything…
      {
        id: 'R-failed',
        state: 'failed',
        idempotencyKey: 'sched:MF:d2',
        missionId: 'MF',
        createdAt: new Date(Date.now() - DAY),
        findings: null,
      },
      // …but the observation before it fingerprinted the SAME calendars.
      {
        id: 'R-ok',
        state: 'completed',
        idempotencyKey: 'sched:MF:d1',
        missionId: 'MF',
        createdAt: new Date(Date.now() - 2 * DAY),
        findings: { findings: [], calendarFingerprint: fingerprintCalendars(cal) },
      },
    );

    const res = await h.svc.tickOnce();

    expect(res.succeeded).toBe(1);
    // Still quiet: the transient failure must not re-trigger the critical
    // finding on an unchanged calendar.
    const review = h.transition.mock.calls.find(
      (c) => (c[3] as { to: string }).to === 'ready_for_review',
    )!;
    expect((review[3] as { findings: { findings: unknown[] } }).findings.findings).toEqual([]);
  });

  it('replaying an occurrence whose run already advanced past planning is a no-op', async () => {
    const h = makeHarness();
    h.missions.push({
      id: 'MF',
      tenantId: T,
      strategyId: null,
      state: 'active',
      cadence: 'daily',
      nextRunAt: new Date(Date.now() - 1000),
    });
    // createRun dedupes on the idempotency key and returns the EXISTING run.
    h.createRun.mockResolvedValue({ id: 'R-firm', state: 'ready_for_review' });

    const res = await h.svc.tickOnce();

    expect(res.succeeded).toBe(1);
    expect(h.transition).not.toHaveBeenCalled();
    // No detection work happens for an already-handled occurrence.
    expect(h.getCalendars).not.toHaveBeenCalled();
  });
});

describe('fingerprintCalendars — stable content fingerprint', () => {
  it('is invariant to row order, ids, tone and position (a re-minted identical fork is NOT a change)', () => {
    const a = makeCalendars();
    const b = makeCalendars();
    b.congress = [...b.congress]
      .reverse()
      .map((r, i) => ({ ...r, id: `re-minted-${i}`, tone: 'warn', position: 90 + i }));
    b.source = { congress: 'override', ppbeLanes: 'baseline', ppbeCurrentPhases: 'baseline' };
    expect(fingerprintCalendars(b)).toBe(fingerprintCalendars(a));
  });

  it('changes when a date moves, a label changes, or a row is added (the signals a firm reviewer must see)', () => {
    const base = fingerprintCalendars(makeCalendars());

    const moved = makeCalendars();
    moved.congress[0] = { ...moved.congress[0]!, startsOn: new Date('2026-05-13T00:00:00.000Z') };
    expect(fingerprintCalendars(moved)).not.toBe(base);

    const relabeled = makeCalendars();
    relabeled.ppbeCurrentPhases[0] = {
      ...relabeled.ppbeCurrentPhases[0]!,
      label: 'Execution FY27',
    };
    expect(fingerprintCalendars(relabeled)).not.toBe(base);

    const added = makeCalendars();
    added.congress.push(refRow('congress_milestone', 'Conference', 2027, '2026-09-10', null));
    expect(fingerprintCalendars(added)).not.toBe(base);
  });
});

describe('WatcherSchedulerService.tick — re-entrancy guard', () => {
  it('skips while a prior tick is still in flight, then runs again after it settles', async () => {
    const h = makeHarness();
    h.missions.push({
      id: 'M1',
      tenantId: T,
      strategyId: 'S1',
      state: 'active',
      cadence: 'daily',
      nextRunAt: new Date(Date.now() - 1000),
    });
    let release!: () => void;
    h.runCheckNow.mockImplementation(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );

    const first = h.svc.tick(); // sets `running` synchronously, then hangs on the watcher call
    const second = h.svc.tick(); // guard: prior tick in flight => no-op
    await second;
    // Flush pending microtasks so the first tick is provably parked on the gate.
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.withSystem).toHaveBeenCalledTimes(1);
    expect(h.runCheckNow).toHaveBeenCalledTimes(1);

    release();
    await first;

    // Guard released: a later tick polls again.
    await h.svc.tick();
    expect(h.withSystem).toHaveBeenCalledTimes(2);
  });
});

describe('WatcherSchedulerService — poisoned-mission isolation', () => {
  it('a throwing mission is caught, its stranded run is failed, and the batch keeps draining', async () => {
    const h = makeHarness();
    const due1 = new Date(Date.now() - 60_000);
    const due2 = new Date(Date.now() - 30_000);
    h.missions.push(
      {
        id: 'M1',
        tenantId: T,
        strategyId: 'S1',
        state: 'active',
        cadence: 'daily',
        nextRunAt: due1,
      },
      {
        id: 'M2',
        tenantId: T,
        strategyId: 'S2',
        state: 'active',
        cadence: 'daily',
        nextRunAt: due2,
      },
    );
    // M1's runCheckNow got far enough to create a run, then blew up mid-check.
    h.runs.push({ id: 'R1', state: 'planning', idempotencyKey: `sched:M1:${day(due1)}` });
    h.runCheckNow.mockImplementation(async (_t, _u, missionId) => {
      if (missionId === 'M1') throw new Error('boom: poisoned mission');
      return undefined;
    });

    const res = await h.svc.tickOnce(); // must NOT throw

    expect(res).toEqual({ claimed: 2, succeeded: 1, failed: 1, skipped: 0 });
    // M2 still ran despite M1 exploding first (earlier dueAt => claimed first).
    expect(h.runCheckNow).toHaveBeenCalledWith(T, null, 'M2', expect.anything());
    // The stranded non-terminal run was transitioned to failed with the error.
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith(
      T,
      null,
      'R1',
      expect.objectContaining({ to: 'failed', error: expect.stringContaining('poisoned mission') }),
    );
  });

  it('a run stranded in queued is canceled (queued cannot legally move to failed)', async () => {
    const h = makeHarness();
    const due = new Date(Date.now() - 1000);
    h.missions.push({
      id: 'M1',
      tenantId: T,
      strategyId: 'S1',
      state: 'active',
      cadence: 'daily',
      nextRunAt: due,
    });
    h.runs.push({ id: 'R1', state: 'queued', idempotencyKey: `sched:M1:${day(due)}` });
    h.runCheckNow.mockImplementation(async () => {
      throw new Error('boom');
    });

    await h.svc.tickOnce();

    expect(h.transition).toHaveBeenCalledWith(
      T,
      null,
      'R1',
      expect.objectContaining({ to: 'canceled' }),
    );
  });

  it("a failed same-day re-check leaves the day's ready_for_review run UNTOUCHED (review surface survives)", async () => {
    const h = makeHarness();
    const due = new Date(Date.now() - 1000);
    h.missions.push({
      id: 'M1',
      tenantId: T,
      strategyId: 'S1',
      state: 'active',
      cadence: 'daily',
      nextRunAt: due,
    });
    // The day's earlier occurrence already succeeded — its run is reviewable.
    h.runs.push({ id: 'R1', state: 'ready_for_review', idempotencyKey: `sched:M1:${day(due)}` });
    // A later same-day re-claim (outbox bring-forward) blows up mid-refresh.
    h.runCheckNow.mockImplementation(async () => {
      throw new Error('refresh exploded');
    });

    const res = await h.svc.tickOnce();

    expect(res.failed).toBe(1);
    // Day-bucketed keys resolve failRunBestEffort to the SAME run the earlier
    // check produced — it must NOT be clobbered to failed (mirrors runCheckNow,
    // whose refresh errors deliberately leave the reviewable run alone).
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('a failure BEFORE the run existed just logs (no transition), and cleanup failures are swallowed', async () => {
    const h = makeHarness();
    h.missions.push({
      id: 'M1',
      tenantId: T,
      strategyId: 'S1',
      state: 'active',
      cadence: 'daily',
      nextRunAt: new Date(Date.now() - 1000),
    });
    h.runCheckNow.mockImplementation(async () => {
      throw new Error('exploded before creating a run');
    });

    const res = await h.svc.tickOnce();

    expect(res.failed).toBe(1);
    expect(h.transition).not.toHaveBeenCalled();

    // And even the cleanup path throwing must not wedge the loop.
    h.missions.find((m) => m.id === 'M1')!.nextRunAt = new Date(Date.now() - 1000);
    h.runs.push({ id: 'R1', state: 'planning', idempotencyKey: 'whatever' });
    h.withTenant.mockImplementation(async () => {
      throw new Error('db down');
    });
    await expect(h.svc.tickOnce()).resolves.toEqual(
      expect.objectContaining({ claimed: 1, failed: 1 }),
    );
  });
});

describe('WatcherSchedulerService — env gates (dark by default)', () => {
  const fakeTimer = () => ({ unref: jest.fn() }) as unknown as ReturnType<typeof setInterval>;

  it('does NOT arm the timer when both switches are off', () => {
    const spy = jest.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer());
    const h = makeHarness();
    h.svc.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does NOT arm on STRATEGY_AGENTS_ENABLED alone — the scheduler switch is ALSO required', () => {
    process.env.STRATEGY_AGENTS_ENABLED = 'true';
    const spy = jest.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer());
    const h = makeHarness();
    h.svc.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does NOT arm on STRATEGY_WATCHER_SCHEDULER alone — the agents kill-switch is ALSO required', () => {
    process.env.STRATEGY_WATCHER_SCHEDULER = 'true';
    const spy = jest.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer());
    const h = makeHarness();
    h.svc.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('arms at the default 60s when both switches are on, and destroy clears it', () => {
    process.env.STRATEGY_AGENTS_ENABLED = 'true';
    process.env.STRATEGY_WATCHER_SCHEDULER = 'true';
    const timer = fakeTimer();
    const setSpy = jest.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearSpy = jest.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const h = makeHarness();
    h.svc.onModuleInit();
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    h.svc.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalledWith(timer);
  });

  it('clamps the poll interval to the 15s floor', () => {
    process.env.STRATEGY_AGENTS_ENABLED = 'true';
    process.env.STRATEGY_WATCHER_SCHEDULER = 'true';
    process.env.STRATEGY_WATCHER_POLL_MS = '1000';
    const spy = jest.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer());
    const h = makeHarness();
    h.svc.onModuleInit();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 15_000);
  });
});
