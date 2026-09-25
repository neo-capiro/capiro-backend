import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { normalizeCompanyName } from '../vendor-reference/vendor-name.util.js';
import {
  parseSourceFamilies,
  validateRunConfig,
  identityAnchorFor,
  runBizDevWatchEvaluation,
  BIZDEV_WATCH_SOURCE_FAMILIES,
  type BizDevWatchRunConfig,
  type BizDevProjectionDb,
  type BizDevWatchRunnerDb,
  type BizDevWatchClaimCandidate,
} from './bizdev-watch-runner.js';

/**
 * Focused runner contract for the Phase 5 DB-only evaluator (current API:
 * withSystem discovery + createMany inserts). Pins:
 *   * config validation fails closed on unknown families / bad bounds;
 *   * identity resolution is explicit: unresolved → pending, no baseline;
 *   * candidate discovery runs EXCLUSIVELY inside db.withSystem;
 *   * an unenrolled tenant (discovery returns nothing) yields no claim;
 *   * first complete pass establishes a QUIET baseline — zero alerts;
 *   * over-bound reads and review/skip diffs → partial, nothing
 *     inserted/delivered, prior baseline preserved;
 *   * backfill drafts are suppressed (never delivered);
 *   * a duplicate replay (createMany count 0) produces no second
 *     delivery/activity and still finalizes the baseline;
 *   * a STALE final lease token rolls back ALL tenant-transaction inserts
 *     (no alert, delivery, activity, baseline, or lease overwrite commits);
 *   * read errors → error state, no baseline advance, family isolation;
 *   * deferred acquisition_revision is marked stale, never read;
 *   * LDA: exact-normalized post-filter (contains-only never an
 *     observation) and exact-over-bound → partial;
 *   * kill-switch off: zero work.
 */

const tenantId = randomUUID();
const watchId = randomUUID();
const stateId = randomUUID();
const prospectId = randomUUID();
const ownerId = randomUUID();
const uei = 'TESTUEI123456';

function anchorEntity(over: Record<string, unknown> = {}) {
  return {
    tenantId: null,
    identityScope: 'global_public',
    canonicalName: 'ACME CORP',
    normalizedName: 'acme corp',
    status: 'active',
    mergedIntoEntityId: null,
    identifiers: [{ identifierType: 'uei', identifierValue: uei }],
    aliases: [{ alias: 'Acme Corporation', normalizedAlias: 'acme corporation' }],
    ...over,
  };
}

describe('config validation', () => {
  const base = (): BizDevWatchRunConfig => ({
    enabled: true,
    sourceFamilies: ['federal_award'],
    maxWatchesPerRun: 50,
    maxRecordsPerSource: 50,
    leaseSeconds: 300,
  });

  test('parseSourceFamilies accepts known families and rejects unknown', () => {
    expect(parseSourceFamilies('federal_award, lda_filing')).toEqual(['federal_award', 'lda_filing']);
    expect(() => parseSourceFamilies('federal_award,made_up')).toThrow(/Unknown BizDev watch source family/);
  });

  test('validateRunConfig fails closed on bad bounds and empty family list', () => {
    expect(() => validateRunConfig({ ...base(), maxWatchesPerRun: 0 })).toThrow();
    expect(() => validateRunConfig({ ...base(), maxRecordsPerSource: 501 })).toThrow();
    expect(() => validateRunConfig({ ...base(), leaseSeconds: 10 })).toThrow();
    expect(() => validateRunConfig({ ...base(), sourceFamilies: [] })).toThrow();
    expect(() => validateRunConfig({ ...base(), sourceFamilies: ['nope'] })).toThrow();
    expect(() => validateRunConfig(base())).not.toThrow();
  });
});

describe('identityAnchorFor', () => {
  const mk = (canonicalEntity: unknown) => ({
    tenantId,
    prospect: {
      id: prospectId,
      status: 'active',
      dismissedAt: null,
      conflictExcluded: false,
      canonicalEntity: canonicalEntity as ReturnType<typeof anchorEntity> | null,
    },
  });

  test('unresolved when no canonical entity', () => {
    expect(identityAnchorFor(mk(null))).toEqual({ resolved: false, uei: null, exactNames: [] });
  });

  test('unresolved when tenant-private entity of ANOTHER tenant', () => {
    expect(
      identityAnchorFor(
        mk(anchorEntity({ tenantId: randomUUID(), identityScope: 'tenant_private' })),
      ).resolved,
    ).toBe(false);
  });

  test('unresolved when merged-away or inactive', () => {
    expect(identityAnchorFor(mk(anchorEntity({ mergedIntoEntityId: randomUUID() }))).resolved).toBe(false);
    expect(identityAnchorFor(mk(anchorEntity({ status: 'inactive' }))).resolved).toBe(false);
  });

  test('resolved with exact UEI + raw canonical and alias names', () => {
    const a = identityAnchorFor(mk(anchorEntity()));
    expect(a).toEqual({ resolved: true, uei, exactNames: ['ACME CORP', 'Acme Corporation'] });
  });

  test('name-only entity still resolves (LDA path), no UEI', () => {
    const a = identityAnchorFor(mk(anchorEntity({ identifiers: [] })));
    expect(a).toEqual({ resolved: true, uei: null, exactNames: ['ACME CORP', 'Acme Corporation'] });
  });
});

// ── Runner harness (current API: withSystem discovery + createMany) ────────

interface StateRow {
  id: string;
  tenantId: string;
  watchId: string;
  sourceFamily: string;
  health: string;
  baselineState: unknown;
  baselinedAt: Date | null;
  lastSuccessfulCompleteCheckAt: Date | null;
  sourceWatermark: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
}

interface AlertRow {
  id: string;
  tenantId: string;
  watchId: string;
  prospectId: string;
  dedupeKey: string;
  fingerprint: string;
  category: string;
  sourceFamily: string;
  recordId: string;
  title: string;
}
interface DeliveryRow {
  id: string;
  tenantId: string;
  alertId: string;
  recipientUserId: string;
  channel: string;
}

function makeHarness(opts: {
  watchStatus?: string;
  mutedUntil?: Date | null;
  prospectConflict?: boolean;
  prospectDismissedAt?: Date | null;
  canonicalEntity?: unknown;
  sourceFamily?: string;
  existingBaseline?: unknown;
  federalAwardRows?: Array<Record<string, unknown>>;
  samRows?: Array<Record<string, unknown>>;
  tangoRows?: Array<Record<string, unknown>>;
  ldaRows?: Array<Record<string, unknown>>;
  readError?: Error;
  maxRecords?: number;
  clock?: () => Date;
  /** Rows the withSystem discovery scan returns (default: our one state). */
  discovered?: BizDevWatchClaimCandidate[];
  /** Force every checked finalizeState updateMany to match ZERO rows. */
  staleFinalToken?: boolean;
  /** Alert dedupeKey already present (duplicate replay). */
  existingAlerts?: Array<{ dedupeKey: string }>;
} = {}) {
  const family = opts.sourceFamily ?? 'federal_award';
  const maxRecords = opts.maxRecords ?? 50;

  const state: StateRow = {
    id: stateId,
    tenantId,
    watchId,
    sourceFamily: family,
    health: 'pending',
    baselineState: opts.existingBaseline ?? null,
    baselinedAt: null,
    lastSuccessfulCompleteCheckAt: null,
    sourceWatermark: null,
    lastError: null,
    consecutiveFailures: 0,
    leaseToken: null,
    leaseUntil: null,
  };

  const alerts: AlertRow[] = [...(opts.existingAlerts ?? []).map((a, i) => ({
    id: `existing-${i}`,
    tenantId,
    watchId,
    prospectId,
    dedupeKey: a.dedupeKey,
    fingerprint: 'existing',
    category: 'contract_award',
    sourceFamily: family,
    recordId: 'CONT_A1',
    title: 'existing',
  }))];
  const deliveries: DeliveryRow[] = [];
  const activities: unknown[] = [];
  let tenantTxCount = 0;
  let systemTxCount = 0;

  const watch = {
    id: watchId,
    tenantId,
    prospectId,
    ownerUserId: ownerId,
    status: opts.watchStatus ?? 'active',
    mutedUntil: opts.mutedUntil ?? null,
    categories: [] as string[],
    prospect: {
      id: prospectId,
      status: 'active',
      dismissedAt: opts.prospectDismissedAt ?? null,
      conflictExcluded: opts.prospectConflict ?? false,
      canonicalEntity: opts.canonicalEntity === undefined ? anchorEntity() : opts.canonicalEntity,
    },
  };

  const tx = {
    tenantMembership: {
      findFirst: jest.fn(async () => ({ id: randomUUID() })),
    },
    businessDevelopmentWatch: {
      findFirst: jest.fn(async ({ where }: { where: { tenantId: string; id: string } }) =>
        where.tenantId === tenantId && where.id === watchId ? watch : null,
      ),
    },
    businessDevelopmentWatchSourceState: {
      findFirst: jest.fn(async ({ where }: { where: { tenantId: string; id: string } }) =>
        where.tenantId === tenantId && where.id === stateId ? state : null,
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { tenantId: string; id: string; leaseToken: string };
          data: Record<string, unknown>;
        }) => {
          // Checked finalize: tenant + id + LEASE TOKEN must all match. The
          // stale-final-token simulation swaps the stored token first, so a
          // predicate on leaseToken makes the update match ZERO rows.
          if (
            where.tenantId !== state.tenantId ||
            where.id !== state.id ||
            where.leaseToken !== state.leaseToken
          ) {
            return { count: 0 };
          }
          for (const k of [
            'health',
            'lastError',
            'leaseToken',
            'leaseUntil',
            'baselineState',
            'baselinedAt',
            'lastSuccessfulCompleteCheckAt',
            'sourceWatermark',
          ] as const) {
            if (k in data) (state as unknown as Record<string, unknown>)[k] = data[k];
          }
          if ('consecutiveFailures' in data && typeof data.consecutiveFailures === 'object') {
            state.consecutiveFailures += 1;
          }
          return { count: 1 };
        },
      ),
    },
    businessDevelopmentAlert: {
      createMany: jest.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          const inserted = data.filter(
            (d) => !alerts.some((a) => a.dedupeKey === (d.dedupeKey as string)),
          );
          if (inserted.length === 0) return { count: 0 };
          for (const d of inserted) {
            alerts.push({
              id: randomUUID(),
              tenantId: d.tenantId as string,
              watchId: d.watchId as string,
              prospectId: d.prospectId as string,
              dedupeKey: (d.dedupeKey ?? '') as string,
              fingerprint: d.fingerprint as string,
              category: d.category as string,
              sourceFamily: d.sourceFamily as string,
              recordId: d.recordId as string,
              title: d.title as string,
            });
          }
          return { count: inserted.length };
        },
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { tenantId: string; watchId: string; dedupeKey: string } }) =>
          alerts.find(
            (a) =>
              a.tenantId === where.tenantId &&
              a.watchId === where.watchId &&
              a.dedupeKey === where.dedupeKey,
          ) ?? null,
      ),
    },
    businessDevelopmentAlertDelivery: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        deliveries.push({
          id: randomUUID(),
          tenantId: data.tenantId as string,
          alertId: data.alertId as string,
          recipientUserId: data.recipientUserId as string,
          channel: (data.channel as string) ?? 'in_app',
        });
        return deliveries[deliveries.length - 1] ?? null;
      }),
    },
    businessDevelopmentProspectActivity: {
      create: jest.fn(async ({ data }: { data: unknown }) => {
        activities.push(data);
        return data;
      }),
    },
    $executeRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      // The transactional lease claim: values[0] is the runner's claimToken
      // (SET lease_token = ${claimToken} …). Apply it to the row, matching
      // the runner's checked updateMany-style semantics.
      state.leaseToken = (values[0] as string) ?? null;
      state.leaseUntil = new Date();
      if (opts.staleFinalToken) {
        // A newer worker took over BEFORE this worker finalized: the stored
        // token is no longer this worker's claim token.
        state.leaseToken = 'newer-worker-token';
      }
      return 1;
    }),
  };

  const discovered = opts.discovered ?? [
    { id: stateId, tenantId, watchId, sourceFamily: family },
  ];

  const db: BizDevWatchRunnerDb = {
    withTenant: async <T,>(
      t: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      tenantTxCount += 1;
      expect(t).toBe(tenantId);
      try {
        return await fn(tx as unknown as Prisma.TransactionClient);
      } catch (error) {
        // Real withTenant rejects the transaction; simulate rollback of the
        // in-memory tenant-side writes so the stale-token test can assert
        // NOTHING from the aborted transaction is visible afterwards.
        alerts.length = 0;
        deliveries.length = 0;
        activities.length = 0;
        throw error;
      }
    },
    withSystem: async <T,>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
      systemTxCount += 1;
      return fn({
        $queryRaw: jest.fn(async () => discovered),
      } as unknown as Prisma.TransactionClient);
    },
  };

  const projections: BizDevProjectionDb = {
    federalAward: {
      findMany: jest.fn(
        async ({
          where,
          take,
        }: {
          where: Record<string, unknown>;
          take?: number;
        }) => {
          if (opts.readError) throw opts.readError;
          const rows = opts.federalAwardRows ?? [
            { ...emptyAward(), awardUniqueId: 'CONT_A1', actionDate: new Date('2026-09-20'), amount: 100, awardingAgency: 'DEPT OF DEFENSE' },
          ];
          if (where && (where as Record<string, unknown>).recipientUei) {
            return rows.slice(0, take ?? rows.length);
          }
          return (opts.federalAwardRows ?? []).slice(0, take ?? 50);
        },
      ),
    } as never,
    federalAssistanceAward: { findMany: jest.fn(async () => []) } as never,
    samOpportunity: {
      findMany: jest.fn(async ({ take }: { take?: number }) => {
        if (opts.readError) throw opts.readError;
        const rows = opts.samRows ?? [];
        return rows.slice(0, take ?? rows.length);
      }),
    } as never,
    tangoResourceSnapshot: {
      findMany: jest.fn(async ({ take }: { take?: number }) => {
        if (opts.readError) throw opts.readError;
        const rows = opts.tangoRows ?? [];
        return rows.slice(0, take ?? rows.length);
      }),
    } as never,
    ldaFiling: {
      findMany: jest.fn(async ({ take }: { take?: number }) => {
        if (opts.readError) throw opts.readError;
        const rows = opts.ldaRows ?? [];
        return rows.slice(0, take ?? rows.length);
      }),
    } as never,
  } as BizDevProjectionDb;

  const config: BizDevWatchRunConfig = {
    enabled: true,
    sourceFamilies: [family],
    maxWatchesPerRun: 10,
    maxRecordsPerSource: maxRecords,
    leaseSeconds: 300,
  };

  return {
    db,
    projections,
    config,
    state,
    watch,
    alerts,
    deliveries,
    activities,
    tx,
    claims: () => tenantTxCount,
    systemScans: () => systemTxCount,
    run: () =>
      runBizDevWatchEvaluation(
        db,
        projections,
        config,
        opts.clock ?? (() => new Date('2026-09-21T00:00:00.000Z')),
      ),
  };
}

function emptyAward(): Record<string, unknown> {
  return {
    piid: 'P1', fain: null, awardingAgency: 'DEPT OF DEFENSE', awardingSubTier: 'ARMY',
    contractorName: 'ACME', recipientUei: uei, amount: 100, peCode: null, dodAcqProgramCode: null,
    fundingTas: null, programActivityCode: null, popState: 'DC', popCongressionalDistrict: '00',
    actionDate: new Date('2026-09-20'), awardedAt: new Date('2026-09-20'),
    baseAwardSignedDate: null, latestActionDate: null, popStartDate: null, popEndDate: null,
    description: null,
  };
}

describe('runBizDevWatchEvaluation — discovery + claim', () => {
  test('discovery runs EXCLUSIVELY through withSystem (no bare cross-tenant query)', async () => {
    const h = makeHarness();
    await h.run();
    expect(h.systemScans()).toBe(1);
    // Every other DB touch (claim, finalize) is a TENANT transaction.
    expect(h.claims()).toBeGreaterThanOrEqual(2);
  });

  test('unenrolled tenant: discovery returns no candidate — no claim, no state write', async () => {
    const h = makeHarness({ discovered: [] });
    const m = await h.run();
    expect(m.checked).toBe(0);
    expect(m.candidates).toBe(0);
    expect(h.state.health).toBe('pending');
    expect(h.state.leaseToken).toBeNull();
    expect(h.tx.businessDevelopmentWatchSourceState.updateMany).not.toHaveBeenCalled();
    expect(h.projections.federalAward.findMany).not.toHaveBeenCalled();
  });

  test('kill-switch off: zero work, no withSystem scan at all', async () => {
    const h = makeHarness();
    h.config.enabled = false;
    const m = await h.run();
    expect(m.checked).toBe(0);
    expect(h.systemScans()).toBe(0);
    expect(m.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runBizDevWatchEvaluation — baseline + healthy path', () => {
  test('first complete pass establishes QUIET baseline, ZERO alerts, healthy, lease released', async () => {
    const h = makeHarness();
    const m = await h.run();
    expect(m.checked).toBe(1);
    expect(m.baselined).toBe(1);
    expect(m.candidates).toBe(1);
    expect(m.delivered).toBe(0); // quiet baseline — first pass never alerts
    expect(h.state.health).toBe('healthy');
    expect(h.state.baselineState).toMatchObject({ initialized: true });
    expect(h.state.baselinedAt).not.toBeNull();
    expect(h.state.lastSuccessfulCompleteCheckAt).not.toBeNull();
    expect(h.state.leaseToken).toBeNull();
    expect(h.state.leaseUntil).toBeNull();
    expect(h.alerts).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
    expect(h.activities).toHaveLength(0);
  });

  test('second pass with a NEW record alerts atomically: alert + owner delivery + activity', async () => {
    const first = makeHarness();
    await first.run();
    const baseline = first.state.baselineState as { initialized: true };
    const h = makeHarness({
      existingBaseline: baseline,
      federalAwardRows: [
        { ...emptyAward(), awardUniqueId: 'CONT_A1', actionDate: new Date('2026-09-20'), amount: 100 },
        { ...emptyAward(), awardUniqueId: 'CONT_NEW', actionDate: new Date('2026-09-24'), amount: 42 },
      ],
    });
    const m = await h.run();
    expect(m.delivered).toBe(1);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.recordId).toBe('CONT_NEW');
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]?.recipientUserId).toBe(ownerId);
    expect(h.activities).toHaveLength(1);
    const activity = h.activities[0] as { body: string; afterJsonb?: { sourceLocator?: string } };
    expect(activity.body).toContain('New watch alert');
    expect(activity.afterJsonb?.sourceLocator).toContain('usaspending.gov');
  });
});

describe('runBizDevWatchEvaluation — partial semantics', () => {
  test('incomplete (over-bound) read → partial, nothing inserted/delivered, prior baseline preserved', async () => {
    const first = makeHarness();
    await first.run();
    const priorBaseline = first.state.baselineState;
    const h = makeHarness({
      existingBaseline: priorBaseline,
      maxRecords: 1,
      federalAwardRows: [
        { awardUniqueId: 'CONT_A1', ...emptyAward() },
        { awardUniqueId: 'CONT_B2', ...emptyAward() },
      ],
    });
    const m = await h.run();
    expect(m.partial).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.state.health).toBe('partial');
    // Prior baseline/watermark preserved
    expect(h.state.baselineState).toEqual(priorBaseline);
    expect(h.state.leaseToken).toBeNull();
  });

  test('review/skip diff outcome → partial: baseline NOT advanced, no alert', async () => {
    const first = makeHarness();
    await first.run();
    const priorBaseline = first.state.baselineState;
    // An observation with a MISSING recordId is a structural 'skip' in the
    // diff — the whole pass must go partial with the baseline preserved.
    const h = makeHarness({
      existingBaseline: priorBaseline,
      federalAwardRows: [
        { awardUniqueId: '', ...emptyAward() }, // recordId falls back to 'unknown'? No: '' → skip
      ],
    });
    const m = await h.run();
    expect(m.partial).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.state.health).toBe('partial');
    expect(h.state.baselineState).toEqual(priorBaseline);
    expect(h.state.leaseToken).toBeNull();
  });

  test('backfill draft is suppressed — never delivered, baseline still advances', async () => {
    const first = makeHarness();
    await first.run();
    const baseline = first.state.baselineState as { initialized: true; establishedAt: string };
    // An OLD record (effective BEFORE the baseline floor) is classified
    // 'backfill' by the diff and must be suppressed, not delivered.
    const h = makeHarness({
      existingBaseline: { ...baseline, establishedAt: new Date('2026-09-21').toISOString() },
      federalAwardRows: [
        { awardUniqueId: 'CONT_A1', ...emptyAward() },
        // Effective date strictly before the floor → backfill
        { ...emptyAward(), awardUniqueId: 'CONT_OLD', actionDate: new Date('2020-01-01') },
      ],
    });
    const m = await h.run();
    expect(m.suppressed).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
    expect(h.state.health).toBe('healthy');
    expect(h.state.baselineState).toMatchObject({ initialized: true });
    expect(
      (h.state.baselineState as { records: Record<string, { suppressionReason?: string }> })
        .records.CONT_OLD?.suppressionReason,
    ).toBe('backfill');
  });

  test('source read error → error state, no baseline advance, no throw, family isolated', async () => {
    const first = makeHarness();
    await first.run();
    const prior = first.state.baselineState;
    const h = makeHarness({
      existingBaseline: prior,
      readError: new Error('projection read failed'),
    });
    const m = await h.run();
    expect(m.failed).toBe(1);
    expect(h.state.health).toBe('error');
    expect(h.state.lastError).toContain('projection read failed');
    expect(h.state.consecutiveFailures).toBe(1);
    expect(h.state.baselineState).toEqual(prior);
    expect(h.alerts).toHaveLength(0);
  });
});

describe('runBizDevWatchEvaluation — duplicate replay + stale lease', () => {
  test('duplicate replay: no second alert/delivery/activity, baseline still finalizes', async () => {
    const first = makeHarness();
    await first.run();
    const baseline = first.state.baselineState as { initialized: true };
    // Seed the exact dedupeKey the second pass will recompute for CONT_NEW.
    const second = makeHarness({
      existingBaseline: baseline,
      federalAwardRows: [
        { ...emptyAward(), awardUniqueId: 'CONT_A1', actionDate: new Date('2026-09-20'), amount: 100 },
        { ...emptyAward(), awardUniqueId: 'CONT_NEW', actionDate: new Date('2026-09-24'), amount: 42 },
      ],
    });
    await second.run();
    expect(second.alerts).toHaveLength(1);
    const dedupeKey = second.alerts[0]?.dedupeKey;
    expect(dedupeKey).toBeTruthy();

    // REPLAY: same records, same established baseline → the same dedupeKey.
    const replay = makeHarness({
      // Simulate a retry after the alert insert committed elsewhere but this
      // worker still holds the PRE-change baseline snapshot.
      existingBaseline: baseline,
      federalAwardRows: [
        { ...emptyAward(), awardUniqueId: 'CONT_A1', actionDate: new Date('2026-09-20'), amount: 100 },
        { ...emptyAward(), awardUniqueId: 'CONT_NEW', actionDate: new Date('2026-09-24'), amount: 42 },
      ],
      existingAlerts: [{ dedupeKey: dedupeKey as string }],
    });
    const m = await replay.run();
    expect(m.duplicates).toBe(1);
    expect(m.delivered).toBe(0);
    // No SECOND delivery or activity for the duplicate.
    expect(replay.deliveries).toHaveLength(0);
    expect(replay.activities).toHaveLength(0);
    // Baseline still finalizes successfully.
    expect(replay.state.health).toBe('healthy');
    expect(replay.state.lastSuccessfulCompleteCheckAt).not.toBeNull();
  });

  test('STALE final token: ZERO-count finalize rolls back ALL tenant-transaction inserts', async () => {
    const first = makeHarness();
    await first.run();
    const baseline = first.state.baselineState as { initialized: true };
    const priorBaseline = first.state.baselineState;
    const h = makeHarness({
      existingBaseline: baseline,
      federalAwardRows: [
        { ...emptyAward(), awardUniqueId: 'CONT_A1', actionDate: new Date('2026-09-20'), amount: 100 },
        { ...emptyAward(), awardUniqueId: 'CONT_NEW', actionDate: new Date('2026-09-24'), amount: 42 },
      ],
      staleFinalToken: true,
    });
    const m = await h.run();
    // The tenant transaction THREW (rolled back): the healthy pass is not
    // claimed as success.
    expect(m.delivered).toBe(0);
    expect(m.baselined).toBe(0);
    // NOTHING from the aborted transaction commits: no alert, no delivery,
    // no activity, no baseline overwrite, no lease overwrite.
    expect(h.alerts).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
    expect(h.activities).toHaveLength(0);
    expect(h.state.baselineState).toEqual(priorBaseline);
    expect(h.state.baselinedAt).toBeNull();
    expect(h.state.lastSuccessfulCompleteCheckAt).toBeNull();
    expect(h.state.health).toBe('pending');
    expect(h.state.leaseToken).not.toBeNull(); // newer worker's lease intact
    expect(h.state.lastSuccessfulCompleteCheckAt).toBeNull();
  });
});

describe('runBizDevWatchEvaluation — deferred + suppression', () => {
  test('deferred acquisition_revision is marked stale and never read', async () => {
    const h = makeHarness({ sourceFamily: 'acquisition_revision' });
    const m = await h.run();
    expect(h.state.health).toBe('stale');
    expect(h.state.lastError).toContain('deferred');
    expect(h.alerts).toHaveLength(0);
    expect(m.baselined).toBe(0);
    // The projection delegate was never queried
    expect(h.projections.federalAward.findMany).not.toHaveBeenCalled();
  });

  test('ended watch is skipped', async () => {
    const h = makeHarness({ watchStatus: 'ended' });
    const m = await h.run();
    expect(m.checked).toBe(0);
    expect(h.state.health).toBe('pending');
  });

  test('unresolved identity stays pending: no baseline, no alert', async () => {
    const h = makeHarness({ canonicalEntity: null });
    const m = await h.run();
    expect(h.state.health).toBe('pending');
    expect(h.state.baselineState).toBeNull();
    expect(h.alerts).toHaveLength(0);
    expect(m.baselined).toBe(0);
  });

  test('paused watch refreshes baseline but suppresses delivery with a persisted reason', async () => {
    const first = makeHarness();
    await first.run();
    const h = makeHarness({
      existingBaseline: first.state.baselineState,
      watchStatus: 'paused',
      federalAwardRows: [
        { awardUniqueId: 'CONT_A1', ...emptyAward() },
        { ...emptyAward(), awardUniqueId: 'CONT_NEW', actionDate: new Date('2026-09-24') },
      ],
    });
    const m = await h.run();
    expect(m.suppressed).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.state.health).toBe('healthy');
    expect(h.state.baselineState).toMatchObject({ initialized: true });
    expect(h.state.lastError).toContain('paused');
    expect(
      (h.state.baselineState as { records: Record<string, { suppressionReason?: string }> })
        .records.CONT_NEW?.suppressionReason,
    ).toBe('watch_paused');
  });

  test('unselected category refreshes baseline but suppresses that alert', async () => {
    const first = makeHarness();
    await first.run();
    const h = makeHarness({
      existingBaseline: first.state.baselineState,
      federalAwardRows: [
        { awardUniqueId: 'CONT_A1', ...emptyAward() },
        { ...emptyAward(), awardUniqueId: 'CONT_U1', actionDate: new Date('2026-09-24') },
      ],
    });
    h.watch.categories = ['lobbying']; // contract_award not selected
    const m = await h.run();
    expect(m.suppressed).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.state.baselineState).toMatchObject({ initialized: true });
    expect(
      (h.state.baselineState as { records: Record<string, { suppressionReason?: string }> })
        .records.CONT_U1?.suppressionReason,
    ).toBe('category_not_selected');
  });
});

describe('runBizDevWatchEvaluation — LDA exact-normalized semantics', () => {
  const nameOnlyEntity = anchorEntity({ identifiers: [] });

  test('contains-only candidates NEVER become observations (exact post-filter)', async () => {
    const first = makeHarness({
      sourceFamily: 'lda_filing',
      canonicalEntity: nameOnlyEntity,
      ldaRows: [
        // 'ACME CORP' normalizes to 'ACME' — exact; 'ACME CORPORATION OF TEXAS'
        // only CONTAINS the name — must be filtered out.
        { filingUuid: 'F_EXACT', clientName: 'ACME CORP', dtPosted: new Date('2026-09-20'), ...emptyLda() },
        { filingUuid: 'F_CONTAINS', clientName: 'ACME CORPORATION OF TEXAS', dtPosted: new Date('2026-09-20'), ...emptyLda() },
      ],
    });
    await first.run();
    const baseline = first.state.baselineState as { initialized: true; records: Record<string, unknown> };
    // Only the EXACT match became a baseline record.
    expect(Object.keys(baseline.records)).toEqual(['F_EXACT']);

    // A new EXACT filing alerts; the contains-only one never does.
    const h = makeHarness({
      sourceFamily: 'lda_filing',
      canonicalEntity: nameOnlyEntity,
      existingBaseline: baseline,
      ldaRows: [
        { filingUuid: 'F_EXACT', clientName: 'ACME CORP', dtPosted: new Date('2026-09-20'), ...emptyLda() },
        { filingUuid: 'F_CONTAINS', clientName: 'ACME CORPORATION OF TEXAS', dtPosted: new Date('2026-09-20'), ...emptyLda() },
        { filingUuid: 'F_NEW', clientName: 'ACME CORPORATION', dtPosted: new Date('2026-09-24'), ...emptyLda() },
      ],
    });
    const m = await h.run();
    expect(m.delivered).toBe(1);
    expect(h.alerts.map((a) => a.recordId)).toEqual(['F_NEW']);
  });

  test('EXACT results over-bound → partial, nothing inserted', async () => {
    const first = makeHarness({
      sourceFamily: 'lda_filing',
      canonicalEntity: nameOnlyEntity,
      ldaRows: [],
    });
    await first.run();
    const priorBaseline = first.state.baselineState;
    const h = makeHarness({
      sourceFamily: 'lda_filing',
      canonicalEntity: nameOnlyEntity,
      existingBaseline: priorBaseline,
      maxRecords: 1,
      ldaRows: [
        { filingUuid: 'F_A', clientName: 'ACME CORP', dtPosted: new Date('2026-09-20'), ...emptyLda() },
        { filingUuid: 'F_B', clientName: 'ACME CORPORATION', dtPosted: new Date('2026-09-20'), ...emptyLda() },
      ],
    });
    const m = await h.run();
    expect(m.partial).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.state.health).toBe('partial');
    expect(h.state.baselineState).toEqual(priorBaseline);
  });
});

function emptySam(): Record<string, unknown> {
  return {
    solicitationNumber: 'S1', noticeType: 'Solicitation', baseType: 'Presolicitation',
    subAgency: null, office: null, setAside: null, setAsideCode: null, pscCode: null,
    naicsCode: null, responseDeadline: null, archiveDate: null, active: true, sourceUrl: null,
  };
}
function emptyLda(): Record<string, unknown> {
  return {
    filingType: 'Q1', filingYear: 2026, filingPeriod: 'Q1', income: 1, expenses: 1,
    registrantId: 1, registrantName: 'R', clientId: 1, clientState: 'DC', issueCodes: [],
    filingDocumentUrl: null,
  };
}

describe('LDA normalization sanity (shared util integration)', () => {
  test('normalizeCompanyName collapses the exact-match family used above', () => {
    expect(normalizeCompanyName('ACME CORP')).toBe(normalizeCompanyName('acme corp'));
    expect(normalizeCompanyName('ACME CORPORATION OF TEXAS')).not.toBe(normalizeCompanyName('acme corp'));
    expect(normalizeCompanyName('ACME CORPORATION')).toBe(normalizeCompanyName('acme corporation'));
  });
});

describe('runner network isolation (INV-0, source-level)', () => {
  test('module source contains no provider/network imports or calls', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.join(__dirname, 'bizdev-watch-runner.ts'),
      'utf8',
    );
    // Strip documentation comments so invariant language in comments can
    // never satisfy or trip the scan.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/from\s+['"]\.\.\/external\//);
    expect(code).not.toMatch(/['"](axios|node-fetch|got|undici|cross-fetch)['"]/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\bhttp\.request\b|\bhttps\.request\b/);
    expect(code).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
  });
});

describe('BIZDEV_WATCH_SOURCE_FAMILIES vocabulary', () => {
  test('acquisition_revision stays in the family list but is deferred at runtime', () => {
    expect(BIZDEV_WATCH_SOURCE_FAMILIES).toContain('acquisition_revision');
  });
});
