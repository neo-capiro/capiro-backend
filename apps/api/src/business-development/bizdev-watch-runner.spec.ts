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
  type BizDevWatchSourceEventSink,
} from './bizdev-watch-runner.js';
import { createSourceEventDispositionSink, SOURCE_EVENT_WORST_CASE_PER_ALERT_MS } from './bizdev-watch-source-event.js';

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
  /** The real column the MB-05 producer reads (internal/canonical event instant). */
  firstObservedAt: Date;
  sourceRevision?: string | null;
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
    /** Alert row already present (duplicate replay, or a durable MB-05 backlog with fixed keys). */
    existingAlerts?: Array<{
      dedupeKey: string;
      id?: string;
      firstObservedAt?: Date;
      recordId?: string;
      fingerprint?: string;
      /** Another source family's alert in the SAME watch: the recovery cursor is per family. */
      sourceFamily?: string;
    }>;
    /** MB-05 delivery owner offered the pass's alerts (absent = no egress at all). */
    sourceEvents?: BizDevWatchSourceEventSink | null;
    /** The pass's own lease length (default 300): the recovery page is sized to fit inside it. */
    leaseSeconds?: number;
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
      id: a.id ?? `existing-${i}`,
      tenantId,
      watchId,
      prospectId,
      dedupeKey: a.dedupeKey,
      fingerprint: a.fingerprint ?? 'existing',
      category: 'contract_award',
      sourceFamily: a.sourceFamily ?? family,
      recordId: a.recordId ?? 'CONT_A1',
      title: 'existing',
      firstObservedAt: a.firstObservedAt ?? new Date('2026-09-20T23:00:00.000Z'),
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
            sourceRevision: (d.sourceRevision ?? null) as string | null,
            firstObservedAt: new Date(opts.clock?.() ?? '2026-09-21T00:00:00.000Z'),
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
      // MB-05 durable reconciliation: the OLDEST-FIRST keyset page the runner issues — strictly AFTER
      // the durable (firstObservedAt, id) cursor pair, ascending, bounded by the per-source take. The
      // predicate is derived from the runner's own WHERE so the fake cannot silently drift from it.
      findMany: jest.fn(
        async ({
          where,
          take,
          orderBy,
        }: {
          where: {
            tenantId: string;
            watchId: string;
            /** The recovery page is scoped to ONE source family, exactly like the real query. */
            sourceFamily?: string;
            OR?: Array<Record<string, any>>;
          };
          take?: number;
          orderBy?: Array<Record<string, string>>;
        }) => {
          let rows = alerts.filter(
            (a) =>
              a.tenantId === where.tenantId &&
              a.watchId === where.watchId &&
              (where.sourceFamily === undefined || a.sourceFamily === where.sourceFamily),
          );
          if (Array.isArray(where.OR) && where.OR.length > 0) {
            // The two clauses are an OR-UNION: strictly-after-instant, or the equal-instant id tie-break.
            const afterAt = where.OR.map((c) => c?.firstObservedAt?.gt).find(
              (v): v is Date => v instanceof Date,
            );
            const tie = where.OR.find(
              (c) => c?.firstObservedAt instanceof Date && typeof c?.id?.gt === 'string',
            );
            rows = rows.filter(
              (a) =>
                (afterAt != null && a.firstObservedAt.getTime() > afterAt.getTime()) ||
                (tie != null &&
                  a.firstObservedAt.getTime() === (tie.firstObservedAt as Date).getTime() &&
                  a.id > (tie.id.gt as string)),
            );
          }
          const ascending = orderBy?.[0]?.firstObservedAt === 'asc';
          const sorted = [...rows].sort((a, b) =>
            ascending
              ? a.firstObservedAt.getTime() - b.firstObservedAt.getTime() ||
                a.id.localeCompare(b.id)
              : b.firstObservedAt.getTime() - a.firstObservedAt.getTime() ||
                b.id.localeCompare(a.id),
          );
          return sorted.slice(0, take ?? sorted.length);
        },
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
    leaseSeconds: opts.leaseSeconds ?? 300,
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
        opts.sourceEvents ?? null,
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

describe('runBizDevWatchEvaluation — MB-05 delivery + bounded durable reconciliation', () => {
  /** The projection shape the healthy path uses to produce exactly one NEW alert in a later pass. */
  const twoRows = () => [
    { ...emptyAward(), awardUniqueId: 'CONT_A1', actionDate: new Date('2026-09-20'), amount: 100 },
    { ...emptyAward(), awardUniqueId: 'CONT_NEW', actionDate: new Date('2026-09-24'), amount: 200 },
  ];

  test('with no delivery owner configured the run reports no source-event egress at all', async () => {
    const first = makeHarness();
    await first.run();
    const h = makeHarness({ existingBaseline: first.state.baselineState as never, federalAwardRows: twoRows() });
    const m = await h.run();
    expect(m.delivered).toBe(1);
    expect(m.sourceEvents).toBeNull();
  });

  test('a delivery owner that cannot answer is UNKNOWN for the committed alert, never a dispatch', async () => {
    const first = makeHarness();
    await first.run();
    const offered: string[] = [];
    const h = makeHarness({
      existingBaseline: first.state.baselineState as never,
      federalAwardRows: twoRows(),
      sourceEvents: async (alerts) => {
        offered.push(...alerts.map((alert) => alert.alertId));
        throw new Error('transport down');
      },
    });
    const m = await h.run();
    // The alert is durably committed, and the delivery owner was offered exactly the one identity.
    expect(m.delivered).toBe(1);
    expect(h.alerts).toHaveLength(1);
    expect(offered).toEqual([h.alerts[0]!.id]);
    expect(m.sourceEvents).toEqual({ offered: 1, dispatched: 0, queued: 0, deduped: 0, refused: 0, unknown: 1, skipped: 0 });
  });

  test('a crash between the commit and the delivery is reconciled by a LATER evaluation on the same immutable identity', async () => {
    const first = makeHarness();
    await first.run();
    const committed = makeHarness({
      existingBaseline: first.state.baselineState as never,
      federalAwardRows: twoRows(),
      sourceEvents: async () => {
        throw new Error('crashed before the delivery owner answered');
      },
    });
    const crashed = await committed.run();
    expect(crashed.delivered).toBe(1);
    const identity = committed.alerts[0]!;
    expect(identity.dedupeKey).toBeTruthy();

    // Restart: the SAME durable state (the committed alert row is the durable channel) and a
    // delivery owner that answers now. The record is already in the baseline, so the diff produces
    // no new draft — only reconciliation can recover the missed handoff.
    const offered: Array<{ alertId: string; dedupeKey: string; occurredAtMs: number }> = [];
    const restarted = makeHarness({
      existingBaseline: committed.state.baselineState as never,
      federalAwardRows: twoRows(),
      existingAlerts: [{ dedupeKey: identity.dedupeKey }],
      sourceEvents: async (alerts) => {
        offered.push(...alerts.map((alert) => ({ alertId: alert.alertId, dedupeKey: alert.dedupeKey, occurredAtMs: alert.occurredAtMs })));
        return { offered: alerts.length, dispatched: alerts.length, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 };
      },
    });
    const recovered = await restarted.run();
    // No second alert, no second in-app delivery and no second activity: the effect did not double.
    expect(recovered.delivered).toBe(0);
    expect(restarted.alerts).toHaveLength(1);
    expect(restarted.deliveries).toHaveLength(0);
    expect(restarted.activities).toHaveLength(0);
    // The re-offered event names the SAME immutable alert identity and the SAME durable instant.
    expect(offered).toEqual([{
      alertId: restarted.alerts[0]!.id,
      dedupeKey: identity.dedupeKey,
      occurredAtMs: restarted.alerts[0]!.firstObservedAt.getTime(),
    }]);
    expect(recovered.sourceEvents).toEqual({ offered: 1, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
  });
});


describe('runBizDevWatchEvaluation — MB-05 oldest-first durable delivery recovery', () => {
  /** One durable alert row with a FIXED keyset (id + instant) so pagination is observable. */
  const backlog = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      dedupeKey: `BK-${i + 1}`,
      id: `id-${i + 1}`,
      firstObservedAt: new Date(`2026-09-0${i + 1}T00:00:00.000Z`),
    }));

  /** The persisted recovery cursor (null until a page is definitively answered). */
  const cursorOf = (h: ReturnType<typeof makeHarness>) =>
    (h.state.baselineState as { scan?: { delivery?: unknown } } | null)?.scan?.delivery ?? null;

  const offeredIds: string[][] = [];
  /** The durable baseline carried between the passes of one scenario. */
  let sharedBaseline: unknown = null;
  /**
   * A per-alert owner: the exact disposition for each offered alert, keyed by alert id. A `recorded`
   * outcome can be named too, which is how a DEDUPED answer proves (or fails to prove) a terminal
   * handoff — ACCEPTED/QUEUED/absent recorded must HOLD the cursor.
   */
  const perAlert = (
    state: (alertId: string) => string | { state: string; recorded?: string | null },
  ) => async (alerts: readonly { alertId: string }[]) => {
    offeredIds.push(alerts.map((a) => a.alertId));
    return {
      dispositions: alerts.map((a) => {
        const answer = state(a.alertId);
        return typeof answer === 'string'
          ? { alertId: a.alertId, state: answer }
          : { alertId: a.alertId, ...answer };
      }),
    };
  };

  beforeEach(() => {
    offeredIds.length = 0;
  });

  test('a backlog larger than one page is walked OLDEST-FIRST through the durable cursor', async () => {
    const seeded = backlog(5);
    // maxRecords 2 = a two-alert page: the read must return the two OLDEST alerts, never the newest two.
    const first = makeHarness({ maxRecords: 2, existingAlerts: seeded, sourceEvents: perAlert(() => 'DISPATCHED') });
    const m = await first.run();
    expect(offeredIds).toEqual([['id-1', 'id-2']]);
    expect(m.sourceEvents).toEqual({ offered: 2, dispatched: 2, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    expect(cursorOf(first)).toEqual({ version: 1, cursorAtMs: seeded[1]!.firstObservedAt.getTime(), cursorId: 'id-2', pagesDone: 1 });

    // The next evaluation resumes STRICTLY AFTER the acknowledged page: the third/fourth oldest, no repeat.
    const second = makeHarness({
      maxRecords: 2,
      existingAlerts: seeded,
      existingBaseline: first.state.baselineState as never,
      sourceEvents: perAlert(() => 'DISPATCHED'),
    });
    await second.run();
    // Only the SECOND page is offered next: the durable cursor resumed strictly after id-2.
    expect(offeredIds.at(-1)).toEqual(['id-3', 'id-4']);
    expect(cursorOf(second)).toEqual({ version: 1, cursorAtMs: seeded[3]!.firstObservedAt.getTime(), cursorId: 'id-4', pagesDone: 2 });

    // And the final, partially-filled page drains the rest exactly once.
    const third = makeHarness({
      maxRecords: 2,
      existingAlerts: seeded,
      existingBaseline: second.state.baselineState as never,
      sourceEvents: perAlert(() => 'DISPATCHED'),
    });
    await third.run();
    expect(offeredIds.at(-1)).toEqual(['id-5']);
    expect(cursorOf(third)).toEqual({ version: 1, cursorAtMs: seeded[4]!.firstObservedAt.getTime(), cursorId: 'id-5', pagesDone: 3 });
  });

  test('an UNKNOWN oldest alert HOLDS the cursor and the same page is re-offered, never skipped', async () => {
    const seeded = backlog(3);
    const options = { maxRecords: 2, existingAlerts: seeded } as const;
    // Two consecutive evaluations whose OLDEST alert is UNKNOWN: identical page, identical hold.
    for (const pass of [0, 1]) {
      const h = makeHarness({
        ...options,
        existingBaseline: pass === 0 ? undefined : (sharedBaseline as never),
        // a2 is definitively answered, but an unresolved OLDER alert must not be stepped over
        sourceEvents: perAlert((alertId) => (alertId === 'id-1' ? 'UNKNOWN' : 'DISPATCHED')),
      });
      const m = await h.run();
      expect(m.sourceEvents).toEqual({ offered: 2, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 1, skipped: 0 });
      expect(cursorOf(h)).toBeNull();
      sharedBaseline = h.state.baselineState;
    }
    // The page never advanced: both passes offered exactly the oldest two.
    expect(offeredIds).toEqual([['id-1', 'id-2'], ['id-1', 'id-2']]);

    // Once the oldest alert is definitively answered, the very next evaluation accepts the whole page.
    const healed = makeHarness({
      ...options,
      existingBaseline: sharedBaseline as never,
      sourceEvents: perAlert(() => 'DISPATCHED'),
    });
    await healed.run();
    expect(cursorOf(healed)).toEqual({ version: 1, cursorAtMs: seeded[1]!.firstObservedAt.getTime(), cursorId: 'id-2', pagesDone: 1 });
  });
  test('equal firstObservedAt rows advance by the id tie-break and are never re-offered', async () => {
    const at = new Date('2026-09-01T00:00:00.000Z');
    const tied = [
      { dedupeKey: 'TIE-A', id: 'aaa', firstObservedAt: at },
      { dedupeKey: 'TIE-B', id: 'bbb', firstObservedAt: at },
    ];
    const first = makeHarness({ maxRecords: 1, existingAlerts: tied, sourceEvents: perAlert(() => 'DISPATCHED') });
    await first.run();
    expect(offeredIds).toEqual([['aaa']]);
    expect(cursorOf(first)).toEqual({ version: 1, cursorAtMs: at.getTime(), cursorId: 'aaa', pagesDone: 1 });

    // Same instant, later id: the equal-instant tie-break resumes at 'bbb' rather than repeating 'aaa'.
    const second = makeHarness({
      maxRecords: 1,
      existingAlerts: tied,
      existingBaseline: first.state.baselineState as never,
      sourceEvents: perAlert(() => 'DISPATCHED'),
    });
    await second.run();
    expect(offeredIds.at(-1)).toEqual(['bbb']);
  });

  test('a new arrival waits behind the backlog instead of jumping the durable cursor', async () => {
    const seeded = backlog(3);
    const first = makeHarness({ maxRecords: 2, existingAlerts: seeded, sourceEvents: perAlert(() => 'DISPATCHED') });
    await first.run();
    // The newest alert (id-3) is NOT delivered while two older alerts are still ahead of it.
    expect(offeredIds).toEqual([['id-1', 'id-2']]);

    const second = makeHarness({
      maxRecords: 2,
      existingAlerts: seeded,
      existingBaseline: first.state.baselineState as never,
      sourceEvents: perAlert(() => 'DISPATCHED'),
    });
    await second.run();
    expect(offeredIds.at(-1)).toEqual(['id-3']);
  });

  test('a concurrent evaluator that takes the lease DURING the bounded call blocks the cursor advance', async () => {
    const seeded = backlog(1);
    const holder: { h?: ReturnType<typeof makeHarness> } = {};
    const before = makeHarness({ maxRecords: 2, existingAlerts: seeded, sourceEvents: async (alerts) => {
      // The bounded delivery call is in flight while a NEWER evaluator claims the source-state row —
      // exactly the window the retained lease exists for. Nothing this stale worker writes may land.
      if (holder.h) holder.h.state.leaseToken = 'concurrent-worker';
      return { dispositions: alerts.map((a) => ({ alertId: a.alertId, state: 'DISPATCHED' })) };
    } });
    holder.h = before;
    const m = await before.run();

    // Meri's answer is still counted honestly (the delivery really happened) …
    expect(m.sourceEvents).toEqual({ offered: 1, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    // … but the durable cursor did NOT advance, and the newer evaluator's lease was not clobbered.
    expect(cursorOf(before)).toBeNull();
    // The committed baseline legitimately landed (the page itself finalized BEFORE the bounded call);
    // what must NOT exist is the recovery cursor this worker had no lease left to write.
    expect((before.state.baselineState as { scan?: Record<string, unknown> }).scan?.delivery).toBeUndefined();
    expect(before.state.leaseToken).toBe('concurrent-worker');
  });

  test('a definite no-effect (no approved routine) disposition advances, unlike UNKNOWN', async () => {
    const seeded = backlog(2);
    const skipped = makeHarness({ maxRecords: 2, existingAlerts: seeded, sourceEvents: perAlert((alertId) => (alertId === 'id-1' ? 'SKIPPED' : 'DISPATCHED')) });
    const m = await skipped.run();
    expect(m.sourceEvents).toEqual({ offered: 2, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 1 });
    // SKIPPED is Meri's own definite "no approved routine for this pair": terminal, so the page advances.
    expect(cursorOf(skipped)).toEqual({ version: 1, cursorAtMs: seeded[1]!.firstObservedAt.getTime(), cursorId: 'id-2', pagesDone: 1 });
  });

  test('an aggregate-only owner acknowledges a page only when it correctly accounts for every alert and reports neither UNKNOWN nor QUEUED', async () => {
    const seeded = backlog(2);
    const pageOf = (counts: Record<string, unknown>) => makeHarness({
      maxRecords: 2,
      existingAlerts: seeded,
      sourceEvents: async () => counts,
    });

    // An UNKNOWN answer cannot acknowledge the page.
    const partial = pageOf({ offered: 2, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 1, skipped: 0 });
    await partial.run();
    expect(cursorOf(partial)).toBeNull();

    // An owner that did not account for every offered alert cannot acknowledge the page.
    const inconsistent = pageOf({ offered: 1, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    await inconsistent.run();
    expect(cursorOf(inconsistent)).toBeNull();

    // A page whose counters do NOT sum to the page size is not correctly accounted either.
    const shortSum = pageOf({ offered: 2, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    await shortSum.run();
    expect(cursorOf(shortSum)).toBeNull();

    // A QUEUED answer is durable but IN FLIGHT: unknown is zero, yet the page must HOLD.
    const queued = pageOf({ offered: 2, dispatched: 1, queued: 1, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    await queued.run();
    expect(cursorOf(queued)).toBeNull();

    // Only a correctly accounted page with neither UNKNOWN nor QUEUED advances.
    const complete = pageOf({ offered: 2, dispatched: 2, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    await complete.run();
    expect(cursorOf(complete)).toEqual({ version: 1, cursorAtMs: seeded[1]!.firstObservedAt.getTime(), cursorId: 'id-2', pagesDone: 1 });
  });

  test('an ACCEPTED/QUEUED oldest alert HOLDS the cursor and the SAME event is re-offered until DISPATCHED', async () => {
    const seeded = backlog(2);
    const options = { maxRecords: 2, existingAlerts: seeded } as const;

    // Pass 1: the oldest alert is merely ACCEPTED/QUEUED — durable acceptance, NOT a completed handoff.
    // The newer alert is dispatched, but an in-flight OLDER answer must not be stepped over.
    const first = makeHarness({
      ...options,
      sourceEvents: perAlert((alertId) => (alertId === 'id-1' ? 'QUEUED' : 'DISPATCHED')),
    });
    const m1 = await first.run();
    expect(m1.sourceEvents).toEqual({ offered: 2, dispatched: 1, queued: 1, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    expect(cursorOf(first)).toBeNull();
    expect(offeredIds).toEqual([['id-1', 'id-2']]);

    // Pass 2: the SAME page is offered again and the same event is answered DISPATCHED — now it advances.
    const second = makeHarness({
      ...options,
      existingBaseline: first.state.baselineState as never,
      sourceEvents: perAlert(() => 'DISPATCHED'),
    });
    const m2 = await second.run();
    expect(m2.sourceEvents).toEqual({ offered: 2, dispatched: 2, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    expect(offeredIds.at(-1)).toEqual(['id-1', 'id-2']);
    expect(cursorOf(second)).toEqual({ version: 1, cursorAtMs: seeded[1]!.firstObservedAt.getTime(), cursorId: 'id-2', pagesDone: 1 });
  });

  test('a DEDUPED answer only advances when its recorded outcome is a true terminal disposition', async () => {
    const seeded = backlog(2);
    const options = { maxRecords: 2, existingAlerts: seeded } as const;

    // Pass 1: DEDUPED whose recorded row state is UNKNOWN — the handoff outcome is NOT confirmed, so
    // the page HOLDS exactly where it is. Same for ACCEPTED/QUEUED/absent/malformed recorded outcomes.
    for (const recorded of ['UNKNOWN', 'ACCEPTED', 'QUEUED', null, 'WAT'] as const) {
      const held = makeHarness({
        ...options,
        sourceEvents: perAlert(() => ({ state: 'DEDUPED', recorded })),
      });
      const m = await held.run();
      // A DEDUPED answer without a terminal recorded outcome is counted UNKNOWN, never a completed handoff.
      expect(m.sourceEvents).toEqual({ offered: 2, dispatched: 0, queued: 0, deduped: 0, refused: 0, unknown: 2, skipped: 0 });
      expect(cursorOf(held)).toBeNull();
      expect(offeredIds.at(-1)).toEqual(['id-1', 'id-2']);
    }

    // Pass 2: DEDUPED with a terminal recorded outcome (Meri's own prior DISPATCHED row) DOES advance.
    const terminal = makeHarness({
      ...options,
      existingBaseline: null,
      sourceEvents: perAlert(() => ({ state: 'DEDUPED', recorded: 'DISPATCHED' })),
    });
    const m2 = await terminal.run();
    expect(m2.sourceEvents).toEqual({ offered: 2, dispatched: 0, queued: 0, deduped: 2, refused: 0, unknown: 0, skipped: 0 });
    expect(cursorOf(terminal)).toEqual({ version: 1, cursorAtMs: seeded[1]!.firstObservedAt.getTime(), cursorId: 'id-2', pagesDone: 1 });
  });

  test('a malformed/unknown disposition fails closed as UNKNOWN and holds the cursor', async () => {
    const seeded = backlog(2);
    const h = makeHarness({
      maxRecords: 2,
      existingAlerts: seeded,
      sourceEvents: perAlert(() => 'WAT'),
    });
    const m = await h.run();
    expect(m.sourceEvents).toEqual({ offered: 2, dispatched: 0, queued: 0, deduped: 0, refused: 0, unknown: 2, skipped: 0 });
    expect(cursorOf(h)).toBeNull();
  });

  test('with no delivery owner configured the run takes NO recovery read and releases the lease', async () => {
    const h = makeHarness({ maxRecords: 2, existingAlerts: backlog(1) });
    const m = await h.run();
    expect(m.sourceEvents).toBeNull();
    expect(h.state.leaseToken).toBeNull();
    expect(cursorOf(h)).toBeNull();
  });

  test('the REAL per-alert delivery owner drives the durable cursor across a crash, a later evaluation and a deduped replay', async () => {
    // The alert row the real codec will read: an immutable id, a real 64-hex semantic fingerprint.
    const seeded = [
      {
        dedupeKey: 'REAL-1',
        id: randomUUID(),
        firstObservedAt: new Date('2026-09-01T00:00:00.000Z'),
        fingerprint: 'b'.repeat(64),
      },
    ];
    const binding = { scheduleId: randomUUID(), generation: 3 };
    /** The durable Meri-side effect: event identity -> the exact bytes it was accepted with. */
    const durable = new Map<string, string>();
    let bindingReads = 0;
    let crash = true;
    const transport = {
      binding: async () => {
        bindingReads += 1;
        return binding;
      },
      event: async (envelope: { eventId: string; eventHash: string }) => {
        if (crash) throw new Error('transport crashed before Meri could answer');
        const known = durable.get(envelope.eventId);
        if (known === undefined) {
          durable.set(envelope.eventId, envelope.eventHash);
          return { status: 200, disposition: 'DISPATCHED', outcome: null, code: null, recorded: 'DISPATCHED',
            eventId: envelope.eventId, eventHash: envelope.eventHash };
        }
        // The SAME identity must arrive with the SAME bytes: identity dedup is the whole safety net.
        expect(known).toBe(envelope.eventHash);
        // A settled row names its own terminal recorded state; DEDUPED only counts as a completed
        // handoff when that outcome is terminal (the receiver reports the prior row's state).
        return { status: 200, disposition: 'DEDUPED', outcome: null, code: null, recorded: 'DISPATCHED',
          eventId: envelope.eventId, eventHash: envelope.eventHash };
      },
    };
    // The real delivery owner (real codec, real disposition parsing) over the live sink boundary.
    const sink = createSourceEventDispositionSink({ transport: transport as never });

    // Pass 1 — committed alert, delivery owner could not answer: UNKNOWN, and the cursor HOLDS.
    const first = makeHarness({ maxRecords: 2, existingAlerts: seeded, sourceEvents: sink });
    const m1 = await first.run();
    expect(m1.sourceEvents).toEqual({ offered: 1, dispatched: 0, queued: 0, deduped: 0, refused: 0, unknown: 1, skipped: 0 });
    expect(cursorOf(first)).toBeNull();
    expect(durable.size).toBe(0);
    expect(bindingReads).toBe(1);

    // Pass 2 — the SAME durable alert, a working owner: DISPATCHED, and the cursor advances.
    crash = false;
    const second = makeHarness({
      maxRecords: 2,
      existingAlerts: seeded,
      existingBaseline: first.state.baselineState as never,
      sourceEvents: sink,
    });
    const m2 = await second.run();
    expect(m2.sourceEvents).toEqual({ offered: 1, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    expect(durable.size).toBe(1);
    expect(cursorOf(second)).toEqual({
      version: 1,
      cursorAtMs: seeded[0]!.firstObservedAt.getTime(),
      cursorId: seeded[0]!.id,
      pagesDone: 1,
    });
    expect(bindingReads).toBe(2);

    // Pass 3 — effect-before-ACK: a worker still holding the OLD baseline re-offers the SAME event. Meri
    // dedups it to the one durable effect rather than a second one, and the page still acknowledges.
    const replay = makeHarness({
      maxRecords: 2,
      existingAlerts: seeded,
      existingBaseline: first.state.baselineState as never,
      sourceEvents: sink,
    });
    const m3 = await replay.run();
    expect(m3.sourceEvents).toEqual({ offered: 1, dispatched: 0, queued: 0, deduped: 1, refused: 0, unknown: 0, skipped: 0 });
    expect(durable.size).toBe(1);
  });

  test('the REAL delivery owner HOLDS a QUEUED oldest event and advances the SAME event once DISPATCHED', async () => {
    // A committed, immutable alert with a real 64-hex fingerprint — the real codec reads it directly.
    const seeded = [
      {
        dedupeKey: 'QUEUED-1',
        id: randomUUID(),
        firstObservedAt: new Date('2026-09-02T00:00:00.000Z'),
        fingerprint: 'c'.repeat(64),
      },
    ];
    const binding = { scheduleId: randomUUID(), generation: 4 };
    /** The durable Meri-side effect: identity -> the exact bytes it was first accepted with. */
    const durable = new Map<string, string>();
    const envelopes: Array<Record<string, unknown>> = [];
    let bindingReads = 0;
    // The barrier: until released, the real owner is answered QUEUED — a DURABLE ACCEPTANCE that is
    // still in flight, which is exactly the case that must never advance the recovery cursor.
    let released = false;
    const transport = {
      binding: async () => {
        bindingReads += 1;
        return binding;
      },
      event: async (envelope: { eventId: string; eventHash: string }) => {
        envelopes.push(envelope as unknown as Record<string, unknown>);
        const known = durable.get(envelope.eventId);
        if (known === undefined) durable.set(envelope.eventId, envelope.eventHash);
        // Every re-offer must carry the SAME canonical bytes: the custody read is unchanged and Meri's
        // identity dedup is the whole safety net against a second effect.
        else expect(known).toBe(envelope.eventHash);
        if (!released) {
          return { status: 200, disposition: 'QUEUED', outcome: 'QUEUED', code: null, recorded: 'QUEUED',
            eventId: envelope.eventId, eventHash: envelope.eventHash };
        }
        return { status: 200, disposition: 'DISPATCHED', outcome: 'DISPATCHED', code: null, recorded: 'DISPATCHED',
          eventId: envelope.eventId, eventHash: envelope.eventHash };
      },
    };
    // The real per-alert delivery owner (real codec, real transport parse) driving the real runner.
    const sink = createSourceEventDispositionSink({ transport: transport as never });

    // Pass 1 — QUEUED: durable acceptance, NOT a completed handoff. Counted honestly, and the cursor HOLDS.
    const first = makeHarness({ maxRecords: 2, existingAlerts: seeded, sourceEvents: sink });
    const m1 = await first.run();
    expect(m1.sourceEvents).toEqual({ offered: 1, dispatched: 0, queued: 1, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    expect(cursorOf(first)).toBeNull();
    expect(bindingReads).toBe(1);

    // Pass 2 — barrier still closed: the SAME page and the SAME event are offered again (never stepped
    // over), with byte-identical custody, and the cursor still holds.
    const second = makeHarness({
      maxRecords: 2,
      existingAlerts: seeded,
      existingBaseline: first.state.baselineState as never,
      sourceEvents: sink,
    });
    const m2 = await second.run();
    expect(m2.sourceEvents).toEqual({ offered: 1, dispatched: 0, queued: 1, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    expect(cursorOf(second)).toBeNull();
    expect(bindingReads).toBe(2);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]).toEqual(envelopes[0]);
    expect(durable.size).toBe(1);

    // Pass 3 — the barrier releases and the SAME event finally settles DISPATCHED: only now does the
    // cursor advance, still over ONE durable effect and the same canonical custody bytes.
    released = true;
    const third = makeHarness({
      maxRecords: 2,
      existingAlerts: seeded,
      existingBaseline: second.state.baselineState as never,
      sourceEvents: sink,
    });
    const m3 = await third.run();
    expect(m3.sourceEvents).toEqual({ offered: 1, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    expect(cursorOf(third)).toEqual({
      version: 1,
      cursorAtMs: seeded[0]!.firstObservedAt.getTime(),
      cursorId: seeded[0]!.id,
      pagesDone: 1,
    });
    expect(bindingReads).toBe(3);
    expect(durable.size).toBe(1);
    expect(envelopes[2]).toEqual(envelopes[0]);
  });

  test('the REAL delivery owner HOLDS a DEDUPED replay whose recorded outcome is UNKNOWN', async () => {
    const seeded = [
      {
        dedupeKey: 'STALE-DEDUPE-1',
        id: randomUUID(),
        firstObservedAt: new Date('2026-09-03T00:00:00.000Z'),
        fingerprint: 'd'.repeat(64),
      },
    ];
    const durable = new Map<string, string>();
    const transport = {
      binding: async () => ({ scheduleId: randomUUID(), generation: 5 }),
      event: async (envelope: { eventId: string; eventHash: string }) => {
        const known = durable.get(envelope.eventId);
        if (known === undefined) durable.set(envelope.eventId, envelope.eventHash);
        else expect(known).toBe(envelope.eventHash);
        // Meri already holds a row for this identity, but that row's RECORDED outcome is UNKNOWN: the
        // handoff is unconfirmed, so the page must HOLD rather than acknowledge past it.
        return { status: 200, disposition: 'DEDUPED', outcome: 'DEDUPED', code: 'SOURCE_EVENT_UNKNOWN', recorded: 'UNKNOWN',
          eventId: envelope.eventId, eventHash: envelope.eventHash };
      },
    };
    const sink = createSourceEventDispositionSink({ transport: transport as never });
    const held = makeHarness({ maxRecords: 2, existingAlerts: seeded, sourceEvents: sink });
    const m = await held.run();
    expect(m.sourceEvents).toEqual({ offered: 1, dispatched: 0, queued: 0, deduped: 0, refused: 0, unknown: 1, skipped: 0 });
    expect(cursorOf(held)).toBeNull();
    expect(durable.size).toBe(1);
  });

  test('the recovery page is scoped to the family the cursor BELONGS to, never watch-wide', async () => {
    // ONE watch, TWO source families. The cursor lives in the (watch, sourceFamily) source-state row,
    // so a watch-wide page would spend THIS family's budget on another family's alerts, advance this
    // family's cursor over them, and deliver them against another family's approved binding.
    const mine = { dedupeKey: 'MINE-1', id: 'id-mine', firstObservedAt: new Date('2026-09-10T00:00:00.000Z') };
    const foreign = {
      dedupeKey: 'OTHER-1',
      id: 'id-other',
      firstObservedAt: new Date('2026-09-01T00:00:00.000Z'), // OLDER: it would lead a watch-wide page
      sourceFamily: 'sam_opportunity',
    };
    const offered: Array<{ alertId: string; sourceFamily: string }> = [];
    const sink = async (alerts: readonly { alertId: string; sourceFamily: string }[]) => {
      offered.push(...alerts.map((a) => ({ alertId: a.alertId, sourceFamily: a.sourceFamily })));
      return { dispositions: alerts.map((a) => ({ alertId: a.alertId, state: 'DISPATCHED' })) };
    };
    const first = makeHarness({ maxRecords: 1, existingAlerts: [mine, foreign], sourceEvents: sink });
    const m = await first.run();
    // The family's OWN oldest alert is offered — never the older alert of the other family.
    expect(offered).toEqual([{ alertId: 'id-mine', sourceFamily: 'federal_award' }]);
    expect(m.sourceEvents).toEqual({ offered: 1, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    expect(cursorOf(first)).toEqual({
      version: 1,
      cursorAtMs: mine.firstObservedAt.getTime(),
      cursorId: 'id-mine',
      pagesDone: 1,
    });

    // This family's channel is complete and the other family's alert is NEVER offered under it: the
    // next pass of the same family offers nothing more and cannot advance the cursor.
    const second = makeHarness({
      maxRecords: 1,
      existingAlerts: [mine, foreign],
      existingBaseline: first.state.baselineState as never,
      sourceEvents: sink,
    });
    offered.length = 0;
    await second.run();
    expect(offered).toEqual([]);
    expect(cursorOf(second)).toEqual(cursorOf(first));
  });

  test('inside the family the cursor keeps the exact (instant, id) order: equal-instant tie, then a new arrival', async () => {
    const T = new Date('2026-09-10T00:00:00.000Z');
    const tie = { dedupeKey: 'TIE', id: 'id-2', firstObservedAt: T }; // same instant, greater id
    const older = { dedupeKey: 'OLD', id: 'id-1', firstObservedAt: T };
    const foreign = {
      dedupeKey: 'OTHER',
      id: 'id-0',
      firstObservedAt: new Date('2026-08-01T00:00:00.000Z'),
      sourceFamily: 'sam_opportunity',
    };
    const later = { dedupeKey: 'LATER', id: 'id-3', firstObservedAt: new Date('2026-09-11T00:00:00.000Z') };
    const offeredIds: string[] = [];
    const sink = async (alerts: readonly { alertId: string }[]) => {
      offeredIds.push(...alerts.map((a) => a.alertId));
      return { dispositions: alerts.map((a) => ({ alertId: a.alertId, state: 'DISPATCHED' })) };
    };
    // Page size 1 so every step of the exact order is observable.
    const first = makeHarness({ maxRecords: 1, existingAlerts: [tie, older, foreign], sourceEvents: sink });
    await first.run();
    expect(offeredIds).toEqual(['id-1']); // equal instant: the smaller id leads
    expect(cursorOf(first)).toEqual({ version: 1, cursorAtMs: T.getTime(), cursorId: 'id-1', pagesDone: 1 });

    const second = makeHarness({
      maxRecords: 1,
      existingAlerts: [tie, older, foreign],
      existingBaseline: first.state.baselineState as never,
      sourceEvents: sink,
    });
    await second.run();
    expect(offeredIds).toEqual(['id-1', 'id-2']); // the tie-break row next, never re-offering id-1
    expect(cursorOf(second)).toEqual({ version: 1, cursorAtMs: T.getTime(), cursorId: 'id-2', pagesDone: 2 });

    // A NEW arrival behind nothing (later instant) is the next work; the other family's row still never is.
    const third = makeHarness({
      maxRecords: 1,
      existingAlerts: [tie, older, foreign, later],
      existingBaseline: second.state.baselineState as never,
      sourceEvents: sink,
    });
    await third.run();
    expect(offeredIds).toEqual(['id-1', 'id-2', 'id-3']);
    expect(cursorOf(third)).toEqual({
      version: 1,
      cursorAtMs: later.firstObservedAt.getTime(),
      cursorId: 'id-3',
      pagesDone: 3,
    });
  });

  test('a page whose delivery cannot finish inside the retained lease is never started', async () => {
    // The worst case per alert is the transport's OWN limits: the binding read plus every bounded
    // attempt (3s each). 9s x 50 alerts would exceed the default 300s lease — the exact bounded-page
    // risk — so the bound is derived from that number instead of being assumed away.
    expect(SOURCE_EVENT_WORST_CASE_PER_ALERT_MS).toBe(9000);
    // A 30s lease fits floor((30000 - 2000) / 9000) = 3 alerts.
    const seeded = backlog(5);
    const offeredIds: string[][] = [];
    const sink = async (alerts: readonly { alertId: string }[]) => {
      offeredIds.push(alerts.map((a) => a.alertId));
      return { dispositions: alerts.map((a) => ({ alertId: a.alertId, state: 'DISPATCHED' })) };
    };
    const first = makeHarness({ maxRecords: 50, leaseSeconds: 30, existingAlerts: seeded, sourceEvents: sink });
    const m = await first.run();
    expect(offeredIds).toEqual([['id-1', 'id-2', 'id-3']]);
    expect(m.sourceEvents).toEqual({ offered: 3, dispatched: 3, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 0 });
    expect(cursorOf(first)).toEqual({
      version: 1,
      cursorAtMs: seeded[2]!.firstObservedAt.getTime(),
      cursorId: 'id-3',
      pagesDone: 1,
    });

    // The alerts that did NOT fit are neither delivered nor skipped: the next pass resumes at the
    // SAME cursor and offers exactly the rest.
    const second = makeHarness({
      maxRecords: 50,
      leaseSeconds: 30,
      existingAlerts: seeded,
      existingBaseline: first.state.baselineState as never,
      sourceEvents: sink,
    });
    await second.run();
    expect(offeredIds.at(-1)).toEqual(['id-4', 'id-5']);
    expect(cursorOf(second)).toEqual({
      version: 1,
      cursorAtMs: seeded[4]!.firstObservedAt.getTime(),
      cursorId: 'id-5',
      pagesDone: 2,
    });
  });
});
