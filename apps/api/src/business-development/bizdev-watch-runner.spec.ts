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
 *   * valid bounded pages persist progress, but only a full cycle advances
 *     complete-source markers; read errors/review preserve prior progress;
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
    expect(parseSourceFamilies('federal_award, lda_filing')).toEqual([
      'federal_award',
      'lda_filing',
    ]);
    expect(() => parseSourceFamilies('federal_award,made_up')).toThrow(
      /Unknown BizDev watch source family/,
    );
  });

  test('validateRunConfig fails closed on bad bounds and empty family list', () => {
    expect(() => validateRunConfig({ ...base(), maxWatchesPerRun: 0 })).toThrow();
    expect(() => validateRunConfig({ ...base(), maxRecordsPerSource: 501 })).toThrow();
    expect(() => validateRunConfig({ ...base(), leaseSeconds: 10 })).toThrow();
    expect(() => validateRunConfig({ ...base(), sourceFamilies: [] })).toThrow();
    expect(() => validateRunConfig({ ...base(), sourceFamilies: ['nope'] })).toThrow();
    expect(() => validateRunConfig(base())).not.toThrow();
  });

  test.each(['maxWatchesPerRun', 'maxRecordsPerSource', 'leaseSeconds'] as const)(
    '%s rejects non-finite and fractional values before database work',
    (field) => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 50.5]) {
        expect(() => validateRunConfig({ ...base(), [field]: value })).toThrow();
      }
    },
  );
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
    expect(identityAnchorFor(mk(anchorEntity({ mergedIntoEntityId: randomUUID() }))).resolved).toBe(
      false,
    );
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
  changeKind?: string;
  title: string;
}
interface DeliveryRow {
  id: string;
  tenantId: string;
  alertId: string;
  recipientUserId: string;
  channel: string;
}

function makeHarness(
  opts: {
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
  } = {},
) {
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

  const alerts: AlertRow[] = [
    ...(opts.existingAlerts ?? []).map((a, i) => ({
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
    })),
  ];
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
          // Prisma semantics: an `undefined` field means "not provided" —
          // never written. A null value IS written.
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
            if (k in data && data[k] !== undefined) {
              (state as unknown as Record<string, unknown>)[k] = data[k];
            }
          }
          if ('consecutiveFailures' in data && typeof data.consecutiveFailures === 'object') {
            state.consecutiveFailures += 1;
          }
          return { count: 1 };
        },
      ),
    },
    businessDevelopmentAlert: {
      createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
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
            changeKind: d.changeKind as string,
            title: d.title as string,
          });
        }
        return { count: inserted.length };
      }),
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

  const discovered = opts.discovered ?? [{ id: stateId, tenantId, watchId, sourceFamily: family }];

  const db: BizDevWatchRunnerDb = {
    withTenant: async <T>(
      t: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      tenantTxCount += 1;
      expect(t).toBe(tenantId);
      const beforeState = structuredClone(state);
      const beforeAlerts = structuredClone(alerts);
      const beforeDeliveries = structuredClone(deliveries);
      const beforeActivities = structuredClone(activities);
      try {
        return await fn(tx as unknown as Prisma.TransactionClient);
      } catch (error) {
        // Real withTenant rejects the transaction; simulate rollback of the
        // in-memory tenant-side writes so the stale-token test can assert
        // NOTHING from the aborted transaction is visible afterwards.
        Object.assign(state, beforeState);
        alerts.splice(0, alerts.length, ...beforeAlerts);
        deliveries.splice(0, deliveries.length, ...beforeDeliveries);
        activities.splice(0, activities.length, ...beforeActivities);
        throw error;
      }
    },
    withSystem: async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
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
          orderBy,
          select,
        }: {
          where?: Record<string, any>;
          take?: number;
          orderBy?: Record<string, string>;
          select?: Record<string, unknown>;
        } = {}) => {
          if (opts.readError) throw opts.readError;
          let rows = opts.federalAwardRows ?? [
            {
              ...emptyAward(),
              awardUniqueId: 'CONT_A1',
              actionDate: new Date('2026-09-20'),
              amount: 100,
              awardingAgency: 'DEPT OF DEFENSE',
            },
          ];
          rows = rows.map((r) => ({ ...r, id: r.id ?? `award-${String(r.awardUniqueId)}` }));
          // Real keyset/fence/take/order semantics (NOT hand-picked pages):
          // filter by identity, cursor (id >), inclusive fence (id <=),
          // order by id ASC, then take.
          if (where?.recipientUei != null) {
            rows = rows.filter((r) => r.recipientUei === where.recipientUei);
          }
          if (where?.awardingAgency?.not !== undefined && where?.awardingAgency?.not === null) {
            rows = rows.filter((r) => r.awardingAgency != null);
          }
          if (where?.id?.gt != null)
            rows = rows.filter((r) => ((r.id as string) ?? '') > where.id.gt);
          if (where?.id?.lte != null)
            rows = rows.filter((r) => ((r.id as string) ?? '') <= where.id.lte);
          const desc = orderBy?.id === 'desc';
          rows = [...rows].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
          if (desc) rows.reverse();
          const limit = take ?? rows.length;
          const out = rows.slice(0, limit);
          return select ? out : out;
        },
      ),
    } as never,
    federalAssistanceAward: { findMany: jest.fn(async () => []) } as never,
    samOpportunity: {
      findMany: jest.fn(
        async ({
          where,
          take,
          orderBy,
        }: {
          where?: Record<string, any>;
          take?: number;
          orderBy?: Record<string, string>;
        } = {}) => {
          if (opts.readError) throw opts.readError;
          let rows = opts.samRows ?? [];
          rows = rows.map((r) => ({ ...r, id: r.id ?? `sam-${String(r.noticeId)}` }));
          if (where?.agency?.in != null) {
            rows = rows.filter((r) => where.agency.in.includes(r.agency));
          }
          if (where?.agency?.not !== undefined && where?.agency?.not === null) {
            rows = rows.filter((r) => r.agency != null);
          }
          if (where?.id?.gt != null)
            rows = rows.filter((r) => ((r.id as string) ?? '') > where.id.gt);
          if (where?.id?.lte != null)
            rows = rows.filter((r) => ((r.id as string) ?? '') <= where.id.lte);
          const desc = orderBy?.id === 'desc';
          rows = [...rows].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
          if (desc) rows.reverse();
          return rows.slice(0, take ?? rows.length);
        },
      ),
    } as never,
    tangoResourceSnapshot: {
      findMany: jest.fn(
        async ({
          where,
          take,
          orderBy,
        }: {
          where?: Record<string, any>;
          take?: number;
          orderBy?: Record<string, string>;
        } = {}) => {
          if (opts.readError) throw opts.readError;
          let rows = opts.tangoRows ?? [];
          rows = rows.map((r) => ({
            ...r,
            id: r.id ?? `tango-${String(r.externalId)}-${String(r.version)}`,
          }));
          if (where?.resourceType) rows = rows.filter((r) => r.resourceType === where.resourceType);
          if (where?.externalId) rows = rows.filter((r) => r.externalId === where.externalId);
          if (where?.active === true) rows = rows.filter((r) => r.active === true);
          if (where?.id?.gt != null)
            rows = rows.filter((r) => ((r.id as string) ?? '') > where.id.gt);
          if (where?.id?.lte != null)
            rows = rows.filter((r) => ((r.id as string) ?? '') <= where.id.lte);
          const desc = orderBy?.id === 'desc';
          rows = [...rows].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
          if (desc) rows.reverse();
          return rows.slice(0, take ?? rows.length);
        },
      ),
    } as never,
    ldaFiling: {
      findMany: jest.fn(
        async ({
          where,
          take,
          orderBy,
        }: {
          where?: Record<string, any>;
          take?: number;
          orderBy?: Record<string, string>;
        } = {}) => {
          if (opts.readError) throw opts.readError;
          let rows = opts.ldaRows ?? [];
          rows = rows.map((r) => ({ ...r, id: r.id ?? `lda-${String(r.filingUuid)}` }));
          // Candidate contains query over raw names.
          if (where?.OR != null) {
            const contains = where.OR.map((c: any) => c.clientName?.contains).filter(Boolean);
            if (contains.length > 0) {
              rows = rows.filter((r) =>
                contains.some((n: string) =>
                  String(r.clientName ?? '')
                    .toLowerCase()
                    .includes(n.toLowerCase()),
                ),
              );
            }
          }
          if (where?.id?.gt != null)
            rows = rows.filter((r) => ((r.id as string) ?? '') > where.id.gt);
          if (where?.id?.lte != null)
            rows = rows.filter((r) => ((r.id as string) ?? '') <= where.id.lte);
          const desc = orderBy?.id === 'desc';
          rows = [...rows].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
          if (desc) rows.reverse();
          return rows.slice(0, take ?? rows.length);
        },
      ),
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
    piid: 'P1',
    fain: null,
    awardingAgency: 'DEPT OF DEFENSE',
    awardingSubTier: 'ARMY',
    contractorName: 'ACME',
    recipientUei: uei,
    amount: 100,
    peCode: null,
    dodAcqProgramCode: null,
    fundingTas: null,
    programActivityCode: null,
    popState: 'DC',
    popCongressionalDistrict: '00',
    actionDate: new Date('2026-09-20'),
    awardedAt: new Date('2026-09-20'),
    baseAwardSignedDate: null,
    latestActionDate: null,
    popStartDate: null,
    popEndDate: null,
    description: null,
  };
}

/** Keep committed source state AND the unique alert/delivery ledger across pages. */
async function runToComplete(h: ReturnType<typeof makeHarness>, maxRuns = 40) {
  const totals = {
    delivered: 0,
    duplicates: 0,
    suppressed: 0,
    partial: 0,
    baselined: 0,
    failed: 0,
  };
  for (let run = 0; run < maxRuns; run += 1) {
    const metrics = await h.run();
    for (const key of Object.keys(totals) as Array<keyof typeof totals>)
      totals[key] += metrics[key];
    if (h.state.health === 'healthy') return totals;
    if (metrics.failed) throw new Error(`Scan failed: ${h.state.lastError}`);
  }
  throw new Error(`Scan did not complete in ${maxRuns} bounded runs: ${h.state.lastError}`);
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
        {
          ...emptyAward(),
          awardUniqueId: 'CONT_A1',
          actionDate: new Date('2026-09-20'),
          amount: 100,
        },
        {
          ...emptyAward(),
          awardUniqueId: 'CONT_NEW',
          actionDate: new Date('2026-09-24'),
          amount: 42,
        },
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
  test('validated non-final page persists progress without advancing the complete watermark', async () => {
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
    h.state.lastSuccessfulCompleteCheckAt = first.state.lastSuccessfulCompleteCheckAt;
    h.state.sourceWatermark = first.state.sourceWatermark;
    const m = await h.run();
    expect(m.partial).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.state.health).toBe('partial');
    // Accepted record state is preserved, but the validated page cursor advances.
    expect((h.state.baselineState as { records: unknown }).records).toEqual(
      (priorBaseline as { records: unknown }).records,
    );
    expect((h.state.baselineState as { scan: { cursorId: string } }).scan.cursorId).toBe(
      'award-CONT_A1',
    );
    expect(h.state.lastSuccessfulCompleteCheckAt).toEqual(
      first.state.lastSuccessfulCompleteCheckAt,
    );
    expect(h.state.sourceWatermark).toEqual(first.state.sourceWatermark);
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
      (h.state.baselineState as { records: Record<string, { suppressionReason?: string }> }).records
        .CONT_OLD?.suppressionReason,
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
        {
          ...emptyAward(),
          awardUniqueId: 'CONT_A1',
          actionDate: new Date('2026-09-20'),
          amount: 100,
        },
        {
          ...emptyAward(),
          awardUniqueId: 'CONT_NEW',
          actionDate: new Date('2026-09-24'),
          amount: 42,
        },
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
        {
          ...emptyAward(),
          awardUniqueId: 'CONT_A1',
          actionDate: new Date('2026-09-20'),
          amount: 100,
        },
        {
          ...emptyAward(),
          awardUniqueId: 'CONT_NEW',
          actionDate: new Date('2026-09-24'),
          amount: 42,
        },
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
        {
          ...emptyAward(),
          awardUniqueId: 'CONT_A1',
          actionDate: new Date('2026-09-20'),
          amount: 100,
        },
        {
          ...emptyAward(),
          awardUniqueId: 'CONT_NEW',
          actionDate: new Date('2026-09-24'),
          amount: 42,
        },
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
      (h.state.baselineState as { records: Record<string, { suppressionReason?: string }> }).records
        .CONT_NEW?.suppressionReason,
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
      (h.state.baselineState as { records: Record<string, { suppressionReason?: string }> }).records
        .CONT_U1?.suppressionReason,
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
        {
          filingUuid: 'F_EXACT',
          clientName: 'ACME CORP',
          dtPosted: new Date('2026-09-20'),
          ...emptyLda(),
        },
        {
          filingUuid: 'F_CONTAINS',
          clientName: 'ACME CORPORATION OF TEXAS',
          dtPosted: new Date('2026-09-20'),
          ...emptyLda(),
        },
      ],
    });
    await first.run();
    const baseline = first.state.baselineState as {
      initialized: true;
      records: Record<string, unknown>;
    };
    // Only the EXACT match became a baseline record.
    expect(Object.keys(baseline.records)).toEqual(['F_EXACT']);

    // A new EXACT filing alerts; the contains-only one never does.
    const h = makeHarness({
      sourceFamily: 'lda_filing',
      canonicalEntity: nameOnlyEntity,
      existingBaseline: baseline,
      ldaRows: [
        {
          filingUuid: 'F_EXACT',
          clientName: 'ACME CORP',
          dtPosted: new Date('2026-09-20'),
          ...emptyLda(),
        },
        {
          filingUuid: 'F_CONTAINS',
          clientName: 'ACME CORPORATION OF TEXAS',
          dtPosted: new Date('2026-09-20'),
          ...emptyLda(),
        },
        {
          filingUuid: 'F_NEW',
          clientName: 'ACME CORPORATION',
          dtPosted: new Date('2026-09-24'),
          ...emptyLda(),
        },
      ],
    });
    const m = await h.run();
    expect(m.delivered).toBe(1);
    expect(h.alerts.map((a) => a.recordId)).toEqual(['F_NEW']);
  });

  test('LDA validated page accepts old records as suppressed backfill without completing coverage', async () => {
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
        {
          filingUuid: 'F_A',
          clientName: 'ACME CORP',
          dtPosted: new Date('2026-09-20'),
          ...emptyLda(),
        },
        {
          filingUuid: 'F_B',
          clientName: 'ACME CORPORATION',
          dtPosted: new Date('2026-09-20'),
          ...emptyLda(),
        },
      ],
    });
    const m = await h.run();
    expect(m.partial).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.state.health).toBe('partial');
    const progress = h.state.baselineState as {
      records: Record<string, { suppressionReason: string }>;
      scan: { cursorId: string };
    };
    expect(progress.scan.cursorId).toBe('lda-F_A');
    expect(progress.records.F_A?.suppressionReason).toBe('backfill');
    expect(h.state.lastSuccessfulCompleteCheckAt).toBeNull();
    expect(h.state.sourceWatermark).toBeNull();
  });
});

function emptySam(): Record<string, unknown> {
  return {
    solicitationNumber: 'S1',
    noticeType: 'Solicitation',
    baseType: 'Presolicitation',
    subAgency: null,
    office: null,
    setAside: null,
    setAsideCode: null,
    pscCode: null,
    naicsCode: null,
    responseDeadline: null,
    archiveDate: null,
    active: true,
    sourceUrl: null,
  };
}
function emptyLda(): Record<string, unknown> {
  return {
    filingType: 'Q1',
    filingYear: 2026,
    filingPeriod: 'Q1',
    income: 1,
    expenses: 1,
    registrantId: 1,
    registrantName: 'R',
    clientId: 1,
    clientState: 'DC',
    issueCodes: [],
    filingDocumentUrl: null,
  };
}

describe('LDA normalization sanity (shared util integration)', () => {
  test('normalizeCompanyName collapses the exact-match family used above', () => {
    expect(normalizeCompanyName('ACME CORP')).toBe(normalizeCompanyName('acme corp'));
    expect(normalizeCompanyName('ACME CORPORATION OF TEXAS')).not.toBe(
      normalizeCompanyName('acme corp'),
    );
    expect(normalizeCompanyName('ACME CORPORATION')).toBe(normalizeCompanyName('acme corporation'));
  });
});

describe('runner network isolation (INV-0, source-level)', () => {
  test('module source contains no provider/network imports or calls', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(__dirname, 'bizdev-watch-runner.ts'), 'utf8');
    // Strip documentation comments so invariant language in comments can
    // never satisfy or trip the scan.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/from\s+['"]\.\.\/external\//);
    expect(code).not.toMatch(/['"](axios|node-fetch|got|undici|cross-fetch)['"]/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\bhttp\.request\b|\bhttps\.request\b/);
    expect(code).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
  });

  test('lease claim casts interpolated UUID text before comparing UUID columns', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(__dirname, 'bizdev-watch-runner.ts'), 'utf8');
    expect(src).toContain('WHERE "id" = ${state.id}::uuid');
    expect(src).toContain('AND "tenant_id" = ${state.tenantId}::uuid');
  });
});

describe('BIZDEV_WATCH_SOURCE_FAMILIES vocabulary', () => {
  test('acquisition_revision stays in the family list but is deferred at runtime', () => {
    expect(BIZDEV_WATCH_SOURCE_FAMILIES).toContain('acquisition_revision');
  });
});

// ── Phase 5 paging: resumable bounded scans (keyset/fence/take enforced) ──
// The harness projection delegates above enforce REAL keyset semantics:
// id > cursor, id <= inclusive fence, orderBy id asc, take — the tests below
// drive the runner through them; no hand-picked pages mirror the runner.

function awardRows(n: number, startId = 1): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    ...emptyAward(),
    id: `award-${String(startId + i).padStart(4, '0')}`,
    awardUniqueId: `CONT_${String(startId + i).padStart(4, '0')}`,
    // Deliberately EQUAL dates and some NULL action dates: dates must never
    // affect traversal.
    actionDate: i % 5 === 0 ? null : new Date('2026-01-01'),
  }));
}

describe('runBizDevWatchEvaluation — resumable initial scan', () => {
  test('292 rows at bound 50: quiet staged pages across runs, then healthy complete baseline', async () => {
    const rows = awardRows(292);
    let baseline: unknown = null;
    let deliveredTotal = 0;
    let baselinedTotal = 0;
    let completed = false;
    for (let run = 1; run <= 10 && !completed; run += 1) {
      const h = makeHarness({
        existingBaseline: baseline,
        maxRecords: 50,
        federalAwardRows: rows,
      });
      const m = await h.run();
      deliveredTotal += m.delivered;
      baselinedTotal += m.baselined;
      completed = (h.state.baselineState as { initialized?: boolean })?.initialized === true;
      // Mid-scan: watermark must stay untouched and coverage honestly partial.
      if (!completed) {
        expect(h.state.lastSuccessfulCompleteCheckAt).toBeNull();
        expect(h.state.sourceWatermark).toBeNull();
        expect(h.state.health).toBe('partial');
      }
      expect(h.alerts).toHaveLength(0);
      expect(h.deliveries).toHaveLength(0);
      baseline = h.state.baselineState;
    }
    expect(completed).toBe(true); // 292/50 = 6 runs
    expect(deliveredTotal).toBe(0); // initial scan is QUIET across ALL chunks
    expect(baselinedTotal).toBe(1); // baselined exactly once, at cycle end
    const finalBaseline = baseline as {
      initialized: boolean;
      records: Record<string, unknown>;
    };
    expect(Object.keys(finalBaseline.records)).toHaveLength(292);
  });

  test('501 rows at bound 50 finish across runs (no 500-ceiling coverage hole)', async () => {
    const rows = awardRows(501);
    let baseline: unknown = null;
    let completed = false;
    for (let run = 0; run < 20 && !completed; run += 1) {
      const h = makeHarness({ existingBaseline: baseline, maxRecords: 50, federalAwardRows: rows });
      await h.run();
      completed = (h.state.baselineState as { initialized?: boolean })?.initialized === true;
      baseline = h.state.baselineState;
    }
    expect(completed).toBe(true);
    expect(Object.keys((baseline as { records: object }).records)).toHaveLength(501);
  });

  test('singleton source completes the cycle in one run (inclusive fence)', async () => {
    const h = makeHarness({
      maxRecords: 50,
      federalAwardRows: [{ ...emptyAward(), id: 'award-0001', awardUniqueId: 'CONT_ONLY' }],
    });
    const m = await h.run();
    expect(m.baselined).toBe(1);
    expect((h.state.baselineState as { initialized: boolean }).initialized).toBe(true);
    expect(h.state.lastSuccessfulCompleteCheckAt).not.toBeNull();
  });

  test('exact-page-size source (50 rows at bound 50) completes in one run', async () => {
    const h = makeHarness({ maxRecords: 50, federalAwardRows: awardRows(50) });
    await h.run();
    expect((h.state.baselineState as { initialized: boolean }).initialized).toBe(true);
  });
});

describe('runBizDevWatchEvaluation — reconciliation cycles', () => {
  async function establish(rows: Array<Record<string, unknown>>, maxRecords = 50) {
    let baseline: unknown = null;
    let completed = false;
    for (let run = 0; run < 20 && !completed; run += 1) {
      const h = makeHarness({ existingBaseline: baseline, maxRecords, federalAwardRows: rows });
      await h.run();
      completed = (h.state.baselineState as { initialized?: boolean })?.initialized === true;
      baseline = h.state.baselineState;
    }
    if (!completed) throw new Error('baseline never completed');
    return baseline;
  }
  async function runCycle(
    rows: Array<Record<string, unknown>>,
    baseline: unknown,
    maxRecords = 50,
  ) {
    const h = makeHarness({ existingBaseline: baseline, maxRecords, federalAwardRows: rows });
    const metrics = await runToComplete(h);
    return { h, metrics, baseline: h.state.baselineState };
  }

  test('deep-history correction (unchanged/null dates) found exactly once next full cycle', async () => {
    const rows = awardRows(120);
    const baseline = await establish(rows, 50);
    // Mutate a DEEP-history record's material WITHOUT touching its dates.
    rows[3] = { ...rows[3]!, amount: 999999, actionDate: rows[3]!.actionDate };
    const first = await runCycle(rows, baseline, 50);
    expect(first.metrics.delivered).toBe(1);
    expect(first.h.alerts).toHaveLength(1);
    expect(first.h.alerts[0]?.changeKind).toBe('material_update');
    // Accepted fingerprints are unchanged on replay; no INSERT is attempted.
    const replay = await runToComplete(first.h);
    expect(replay.duplicates).toBe(0);
    expect(replay.delivered).toBe(0);
    expect(first.h.alerts).toHaveLength(1);
    expect(first.h.deliveries).toHaveLength(1);
  });

  test('insertion into already-walked key range found in a later cycle', async () => {
    const rows = awardRows(120);
    const h = makeHarness({ maxRecords: 50, federalAwardRows: rows });
    await runToComplete(h);
    await h.run();
    expect((h.state.baselineState as { scan: { cursorId: string } }).scan.cursorId).toBe(
      'award-0050',
    );
    // Insert only AFTER the traversal has passed this key. The event date is
    // current; an old event would instead be correctly backfill-suppressed.
    rows.push({
      ...emptyAward(),
      id: 'award-0001-x',
      awardUniqueId: 'CONT_INSERTED',
      actionDate: new Date('2026-09-24'),
    });
    await runToComplete(h);
    expect(h.alerts).toHaveLength(0);
    const metrics = await runToComplete(h);
    expect(metrics.delivered).toBe(1);
    expect(h.alerts.map((a) => a.recordId)).toEqual(['CONT_INSERTED']);
    await runToComplete(h);
    expect(h.alerts).toHaveLength(1);
    expect(h.deliveries).toHaveLength(1);
  });

  test('page read error preserves cursor and previous accepted progress', async () => {
    const rows = awardRows(120);
    const baseline = await establish(rows, 50);
    // First cycle run: healthy page advances the cursor.
    const h1 = makeHarness({ existingBaseline: baseline, maxRecords: 50, federalAwardRows: rows });
    await h1.run();
    const advanced = h1.state.baselineState;
    const cursor = (advanced as { scan: { cursorId: string } }).scan.cursorId;
    expect(cursor).toBeTruthy();
    // Second run with a read ERROR: cursor and watermark unchanged.
    const h2 = makeHarness({
      existingBaseline: advanced,
      maxRecords: 50,
      federalAwardRows: rows,
      readError: new Error('projection read failed mid-cycle'),
    });
    const m2 = await h2.run();
    expect(m2.failed).toBe(1);
    expect(h2.state.health).toBe('error');
    expect((h2.state.baselineState as { scan: { cursorId: string } }).scan.cursorId).toBe(cursor);
    expect(h2.state.lastSuccessfulCompleteCheckAt).toBeNull();
    // Prior accepted page progress survives in the baseline records map.
    expect(Object.keys((h2.state.baselineState as { records: object }).records)).toHaveLength(
      Object.keys((baseline as { records: object }).records).length,
    );
  });

  test('review page (skip diff) does not advance the cursor past its start', async () => {
    const rows = awardRows(120);
    const baseline = await establish(rows, 50);
    const h1 = makeHarness({ existingBaseline: baseline, maxRecords: 50, federalAwardRows: rows });
    await h1.run();
    const advanced = h1.state.baselineState;
    // A row with a MISSING recordId routes to 'skip' — incomplete page. The
    // bad row is placed ON the NEXT page (after the committed cursor), so
    // this run's page starts at the cursor and cannot advance past it.
    const cursorAfterPage1 = (advanced as { scan: { cursorId: string } }).scan.cursorId;
    const badRowIndex = rows.findIndex((r) => (r.id as string) > cursorAfterPage1);
    const badRows = rows.map((r, i) => (i === badRowIndex ? { ...r, awardUniqueId: '' } : r));
    const h2 = makeHarness({
      existingBaseline: advanced,
      maxRecords: 50,
      federalAwardRows: badRows,
    });
    const m = await h2.run();
    expect(m.partial).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h2.state.health).toBe('partial');
    // Cursor preserved at the cycle start (no advance past an incomplete page).
    expect((h2.state.baselineState as { scan: { cursorId: string } }).scan.cursorId).toBe(
      (advanced as { scan: { cursorId: string } }).scan.cursorId,
    );
  });
});

describe('runBizDevWatchEvaluation — checkpoint compatibility + scope', () => {
  test('LEGACY baseline (no scan metadata) keeps working: fresh cycle synthesizes a checkpoint', async () => {
    // A legacy established baseline with no `scan` field.
    const legacy = {
      initialized: true,
      establishedAt: new Date('2026-09-21').toISOString(),
      effectiveFloorAt: null,
      records: {},
    };
    const h = makeHarness({
      existingBaseline: legacy,
      maxRecords: 50,
      federalAwardRows: awardRows(10),
    });
    const m = await h.run();
    // The legacy empty-records baseline treats every record as new — but the
    // fresh cycle completes in one page and the scan checkpoint is created.
    expect(h.state.health).toBe('healthy');
    const scan = (h.state.baselineState as { scan?: { version: number; phase: string } }).scan;
    expect(scan?.version).toBe(1);
    expect(scan?.phase).toBe('cycle');
  });

  test('MALFORMED checkpoint fails closed: partial, no advance, no crash', async () => {
    const malformed = {
      initialized: false,
      establishedAt: new Date('2026-09-21').toISOString(),
      records: {},
      scan: { version: 99, phase: 'initial' }, // NEWER version → unusable
    };
    const h = makeHarness({
      existingBaseline: malformed,
      maxRecords: 50,
      federalAwardRows: awardRows(10),
    });
    const m = await h.run();
    expect(m.partial).toBe(1);
    expect(h.state.health).toBe('partial');
    expect(h.state.lastError).toContain('checkpoint');
    expect(h.state.baselineState).toEqual(malformed); // unchanged, not fabricated
    expect(h.alerts).toHaveLength(0);
  });

  test('scope change (identity anchor changed) restarts QUIET: no cross-entity diff, no storm', async () => {
    const rows = awardRows(10);
    let baseline: unknown = null;
    let completed = false;
    for (let run = 0; run < 5 && !completed; run += 1) {
      const h = makeHarness({ existingBaseline: baseline, maxRecords: 50, federalAwardRows: rows });
      await h.run();
      completed = (h.state.baselineState as { initialized?: boolean })?.initialized === true;
      baseline = h.state.baselineState;
    }
    expect(completed).toBe(true);
    // CHANGE the identity anchor (different UEI + names).
    const newAnchor = anchorEntity({
      canonicalName: 'BETA CORP',
      normalizedName: 'beta corp',
      identifiers: [{ identifierType: 'uei', identifierValue: 'OTHERUEI1' }],
      aliases: [{ alias: 'Beta Corporation', normalizedAlias: 'beta corporation' }],
    });
    const rows2 = awardRows(8, 500).map((r) => ({ ...r, recipientUei: 'OTHERUEI1' }));
    const h = makeHarness({
      existingBaseline: baseline,
      canonicalEntity: newAnchor,
      maxRecords: 3,
      federalAwardRows: rows2,
    });
    const oldCompleted = new Date('2026-09-20T00:00:00Z');
    h.state.baselinedAt = oldCompleted;
    h.state.lastSuccessfulCompleteCheckAt = oldCompleted;
    h.state.sourceWatermark = oldCompleted;
    const m = await h.run();
    // Quiet re-baseline of the newly scoped identity: zero alerts/deliveries.
    expect(m.delivered).toBe(0);
    expect(h.alerts).toHaveLength(0);
    const scan = (h.state.baselineState as { scan?: { phase: string } }).scan;
    expect(scan?.phase).toBe('initial');
    // Completion of the OLD entity is not evidence about the new scope.
    expect(h.state.baselinedAt).toBeNull();
    expect(h.state.lastSuccessfulCompleteCheckAt).toBeNull();
    expect(h.state.sourceWatermark).toBeNull();
    await runToComplete(h);
    const completedBaseline = h.state.baselineState as {
      initialized: boolean;
      records: Record<string, unknown>;
    };
    expect(completedBaseline.initialized).toBe(true);
    expect(Object.keys(completedBaseline.records)).toHaveLength(8);
    expect(completedBaseline.records.CONT_0001).toBeUndefined();
    expect(h.alerts).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
  });
});

describe('runBizDevWatchEvaluation — LDA + SAM paging specifics', () => {
  const nameOnlyEntity = anchorEntity({ identifiers: [] });

  test('LDA: many nonmatches before an exact match still progress and alert once', async () => {
    // 120 contains-only candidates BEFORE the exact match — the old 4x
    // candidate-cap design would dead-end; the paged walk must reach it.
    const rows = [
      ...Array.from({ length: 120 }, (_, i) => ({
        ...emptyLda(),
        id: `lda-${String(i).padStart(4, '0')}`,
        filingUuid: `F_NOISE_${i}`,
        clientName: 'ACME CORPORATION OF TEXAS',
        dtPosted: new Date('2026-09-20'),
      })),
      {
        ...emptyLda(),
        id: 'lda-0120',
        filingUuid: 'F_EXACT_LATE',
        clientName: 'ACME CORP',
        dtPosted: new Date('2026-09-20'),
      },
    ];
    let baseline: unknown = null;
    let completed = false;
    for (let run = 0; run < 10 && !completed; run += 1) {
      const h = makeHarness({
        sourceFamily: 'lda_filing',
        canonicalEntity: nameOnlyEntity,
        existingBaseline: baseline,
        maxRecords: 50,
        ldaRows: rows,
      });
      await h.run();
      completed = (h.state.baselineState as { initialized?: boolean })?.initialized === true;
      baseline = h.state.baselineState;
    }
    expect(completed).toBe(true);
    const records = (baseline as { records: Record<string, unknown> }).records;
    expect(Object.keys(records)).toEqual(['F_EXACT_LATE']);
  });

  test('SAM: agency appearing only after award 100 remains visible', async () => {
    // 150 awards: agency B appears ONLY in awards 101-150 — invisible under
    // the old hardcoded newest-100 exposure read.
    const awards = Array.from({ length: 150 }, (_, i) => ({
      ...emptyAward(),
      id: `award-${String(i + 1).padStart(4, '0')}`,
      awardUniqueId: `CONT_${String(i + 1).padStart(4, '0')}`,
      awardingAgency: i < 100 ? 'DEPT OF A' : 'DEPT OF B',
    }));
    const samRows = [
      {
        ...emptySam(),
        id: 'opp-0001',
        noticeId: 'OPP_A1',
        agency: 'DEPT OF A',
        title: 'A Opp',
        postedDate: new Date('2026-09-20'),
      },
      {
        ...emptySam(),
        id: 'opp-0002',
        noticeId: 'OPP_B1',
        agency: 'DEPT OF B',
        title: 'B Opp',
        postedDate: new Date('2026-09-20'),
      },
    ];
    let baseline: unknown = null;
    let completed = false;
    for (let run = 0; run < 10 && !completed; run += 1) {
      const h = makeHarness({
        sourceFamily: 'sam_opportunity',
        existingBaseline: baseline,
        maxRecords: 50,
        federalAwardRows: awards, // exposure walk reads these
        samRows,
      });
      await h.run();
      completed = (h.state.baselineState as { initialized?: boolean })?.initialized === true;
      baseline = h.state.baselineState;
    }
    expect(completed).toBe(true);
    const records = (baseline as { records: Record<string, unknown> }).records;
    expect(Object.keys(records).sort()).toEqual(['OPP_A1', 'OPP_B1']);
  });
});

describe('runBizDevWatchEvaluation — SAM exposure-first paging', () => {
  const bound = 2;

  function samAwards(n: number): Array<Record<string, unknown>> {
    // First n-1 awards: DEPT OF A; LAST award (highest id): DEPT OF B —
    // agency B is discovered only on the LAST exposure page.
    return Array.from({ length: n }, (_, i) => ({
      ...emptyAward(),
      id: `award-${String(i + 1).padStart(4, '0')}`,
      awardUniqueId: `EXP_${String(i + 1).padStart(4, '0')}`,
      awardingAgency: i < n - 1 ? 'DEPT OF A' : 'DEPT OF B',
    }));
  }

  function samOpps(): Array<Record<string, unknown>> {
    // The LATE agency (B) owns the LOWEST opportunity id; earlier agency A
    // owns 6 higher-id opportunities (bound 2 → >1 opportunity page).
    return [
      {
        ...emptySam(),
        id: 'opp-0001',
        noticeId: 'OPP_B_LOW',
        agency: 'DEPT OF B',
        postedDate: new Date('2026-09-20'),
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        ...emptySam(),
        id: `opp-${String(10 + i).padStart(4, '0')}`,
        noticeId: `OPP_A_${i}`,
        agency: 'DEPT OF A',
        postedDate: new Date('2026-09-20'),
      })),
    ];
  }

  test('exposure-first: no SAM read before exposure completes; frozen-set fence reaches the late agency lower-id opp quietly', async () => {
    const awards = samAwards(5); // bound 2 → exposure pages 2,2,1 → 3 runs
    const opps = samOpps();
    const h = makeHarness({
      sourceFamily: 'sam_opportunity',
      maxRecords: bound,
      federalAwardRows: awards,
      samRows: opps,
    });
    const awardMock = h.projections.federalAward.findMany as unknown as jest.Mock;
    const samMock = h.projections.samOpportunity.findMany as unknown as jest.Mock;
    let baseline: unknown = null;
    let completed = false;
    let opportunityPages = 0;
    for (let run = 0; run < 30 && !completed; run += 1) {
      const exposureCompleteAtStart =
        ((baseline as { scan?: { exposure?: { complete?: boolean } } } | null)?.scan?.exposure
          ?.complete ?? false) === true;
      awardMock.mockClear();
      samMock.mockClear();
      await h.run();
      completed = (h.state.baselineState as { initialized?: boolean })?.initialized === true;
      // Exposure strictly FIRST: every SAM read must come after the LAST
      // federalAward read of the same run (exposure walk finished first).
      const awardOrders = awardMock.mock.invocationCallOrder;
      const samOrders = samMock.mock.invocationCallOrder;
      if (run < 2) expect(samOrders).toHaveLength(0);
      if (samOrders.length > 0) {
        expect(Math.max(...awardOrders)).toBeLessThan(Math.min(...samOrders));
      }
      if (exposureCompleteAtStart) {
        // Complete exposure is REUSED: no federalAward reads while paging
        // opportunities — and more than one opportunity page at bound 2.
        expect(awardOrders).toHaveLength(0);
        if (!completed) opportunityPages += 1;
      }
      // Every projection read stays bounded: page+1 probe, or a take-1 fence probe.
      for (const call of awardMock.mock.calls) {
        const take = (call[0] as { take?: number }).take;
        expect(take === bound + 1 || take === 1).toBe(true);
      }
      for (const call of samMock.mock.calls) {
        const take = (call[0] as { take?: number }).take;
        expect(take === bound + 1 || take === 1).toBe(true);
      }
      expect(h.alerts).toHaveLength(0); // same durable ledger for the entire initial cycle
      expect(h.deliveries).toHaveLength(0);
      baseline = h.state.baselineState;
    }
    expect(completed).toBe(true);
    expect(opportunityPages).toBeGreaterThanOrEqual(2); // >1 opportunity page at bound 2
    const records = (baseline as { records: Record<string, unknown> }).records;
    expect(Object.keys(records).sort()).toEqual([
      'OPP_A_0',
      'OPP_A_1',
      'OPP_A_2',
      'OPP_A_3',
      'OPP_A_4',
      'OPP_A_5',
      'OPP_B_LOW',
    ]);
  });

  test('exposure read failure after persisted progress: checkpoint/baseline unchanged, no alert', async () => {
    const awards = samAwards(5);
    const opps = samOpps();
    // Run 1: partial exposure progress commits.
    const h1 = makeHarness({
      sourceFamily: 'sam_opportunity',
      maxRecords: bound,
      federalAwardRows: awards,
      samRows: opps,
    });
    await h1.run();
    expect(h1.state.health).toBe('partial');
    const committed = h1.state.baselineState;
    // Run 2 with a read ERROR: committed progress is untouched, no alert.
    const h2 = makeHarness({
      sourceFamily: 'sam_opportunity',
      existingBaseline: committed,
      maxRecords: bound,
      federalAwardRows: awards,
      samRows: opps,
      readError: new Error('exposure read failed mid-walk'),
    });
    const m = await h2.run();
    expect(m.failed).toBe(1);
    expect(h2.state.health).toBe('error');
    expect(h2.state.lastError).toContain('exposure read failed');
    expect(h2.state.baselineState).toEqual(committed); // checkpoint unchanged
    expect(h2.alerts).toHaveLength(0);
    expect(h2.deliveries).toHaveLength(0);
    expect(h2.state.consecutiveFailures).toBe(1);
    // The walk resumes cleanly afterwards and completes.
    let baseline: unknown = committed;
    let completed = false;
    for (let run = 0; run < 30 && !completed; run += 1) {
      const h = makeHarness({
        sourceFamily: 'sam_opportunity',
        existingBaseline: baseline,
        maxRecords: bound,
        federalAwardRows: awards,
        samRows: opps,
      });
      await h.run();
      completed = (h.state.baselineState as { initialized?: boolean })?.initialized === true;
      baseline = h.state.baselineState;
    }
    expect(completed).toBe(true);
  });

  test('empty agency set: no SAM read at all, cycle completes quietly', async () => {
    const awards = Array.from({ length: 3 }, (_, i) => ({
      ...emptyAward(),
      id: `award-${String(i + 1).padStart(4, '0')}`,
      awardUniqueId: `EXP_${String(i + 1).padStart(4, '0')}`,
      awardingAgency: null, // no agency exposure at all
    }));
    const h = makeHarness({
      sourceFamily: 'sam_opportunity',
      maxRecords: bound,
      federalAwardRows: awards,
      samRows: samOpps(),
    });
    const m = await h.run();
    expect(h.projections.samOpportunity.findMany).not.toHaveBeenCalled();
    expect(m.delivered).toBe(0);
    expect(m.baselined).toBe(1);
    expect(h.state.health).toBe('healthy');
    expect(h.alerts).toHaveLength(0);
    expect(Object.keys((h.state.baselineState as { records: object }).records)).toHaveLength(0);
  });
});

describe('runBizDevWatchEvaluation — suppression across page boundaries', () => {
  test('paused watch mid-cycle: page progress persists, delivery suppressed, resumes without replay alerts', async () => {
    const rows = awardRows(120);
    const h = makeHarness({ maxRecords: 50, federalAwardRows: rows });
    await runToComplete(h);
    // A NEW record appears while the watch is PAUSED: the cycle page
    // progresses, the delivery is suppressed with a persisted reason, and a
    // later resumed replay does NOT emit it again (baseline accepted).
    rows.push({
      ...emptyAward(),
      id: 'award-9999',
      awardUniqueId: 'CONT_PAUSED_NEW',
      actionDate: new Date('2026-09-24'),
    });
    h.watch.status = 'paused';
    const firstPage = await h.run();
    expect(firstPage.suppressed).toBe(0); // row has not been observed yet
    expect(h.state.health).toBe('partial');
    const m = await runToComplete(h);
    expect(m.suppressed).toBe(1);
    expect(m.delivered).toBe(0);
    expect(h.state.health).toBe('healthy');
    expect(
      (h.state.baselineState as { records: Record<string, { suppressionReason: string }> }).records
        .CONT_PAUSED_NEW?.suppressionReason,
    ).toBe('watch_paused');
    // Resume (active) and replay: no second delivery for the same record.
    h.watch.status = 'active';
    const m2 = await runToComplete(h);
    expect(m2.delivered).toBe(0);
    expect(m2.duplicates).toBe(0); // suppressed draft was never inserted
    expect(h.alerts).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
  });
});

describe('paging keeps the durable alert ledger across cycles', () => {
  test.each(['federal_award', 'federal_assistance_award', 'sam_opportunity', 'tango_resource'])(
    '%s stays pending without an exact UEI rather than claiming complete empty coverage',
    async (sourceFamily) => {
      const h = makeHarness({ sourceFamily, canonicalEntity: anchorEntity({ identifiers: [] }) });
      const metrics = await h.run();
      expect(h.state.health).toBe('pending');
      expect(h.state.lastError).toContain('Exact UEI');
      expect(h.state.baselineState).toBeNull();
      expect(h.state.lastSuccessfulCompleteCheckAt).toBeNull();
      expect(metrics.baselined).toBe(0);
      expect(h.alerts).toHaveLength(0);
      expect(h.deliveries).toHaveLength(0);
      for (const delegate of Object.values(h.projections)) {
        expect(delegate.findMany).not.toHaveBeenCalled();
      }
    },
  );

  test('A → B → A → B is three real changes; replay of each accepted state is quiet', async () => {
    const rows = awardRows(61);
    const h = makeHarness({ maxRecords: 20, federalAwardRows: rows });
    await runToComplete(h);
    for (const [index, amount] of [200, 100, 200].entries()) {
      rows[2] = { ...rows[2]!, amount };
      const changed = await runToComplete(h);
      expect(changed.delivered).toBe(1);
      expect(h.alerts).toHaveLength(index + 1);
      expect(h.deliveries).toHaveLength(index + 1);
      const replay = await runToComplete(h);
      expect(replay.delivered).toBe(0);
      expect(h.alerts).toHaveLength(index + 1);
    }
    expect(new Set(h.alerts.map((alert) => alert.dedupeKey)).size).toBe(3);
  });

  test('an old record inserted behind the cursor is eventually recorded but never breaking news', async () => {
    const rows = awardRows(61);
    const h = makeHarness({ maxRecords: 20, federalAwardRows: rows });
    await runToComplete(h);
    await h.run();
    rows.push({
      ...emptyAward(),
      id: 'award-0001-old',
      awardUniqueId: 'CONT_OLD',
      actionDate: new Date('2019-01-01'),
    });
    await runToComplete(h);
    const found = await runToComplete(h);
    expect(found.suppressed).toBe(1);
    expect(found.delivered).toBe(0);
    expect(
      (h.state.baselineState as { records: Record<string, { suppressionReason: string }> }).records
        .CONT_OLD?.suppressionReason,
    ).toBe('backfill');
    await runToComplete(h);
    expect(h.alerts).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
  });

  test('owner revocation between pages preserves accepted progress and creates no delivery', async () => {
    const rows = awardRows(61);
    const h = makeHarness({ maxRecords: 20, federalAwardRows: rows });
    await runToComplete(h);
    await h.run();
    const progress = structuredClone(h.state.baselineState);
    h.tx.tenantMembership.findFirst.mockResolvedValueOnce(null as never);
    rows[25] = { ...rows[25]!, amount: 500 };
    const revoked = await h.run();
    expect(revoked.delivered).toBe(0);
    expect(h.state.health).toBe('pending');
    expect(h.state.baselineState).toEqual(progress);
    expect(h.alerts).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
  });
});
