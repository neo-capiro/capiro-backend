import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { BizDevWatchService } from './bizdev-watch.service.js';
import { encodeCursor, decodeCursor } from './bizdev-watch.service.js';

/**
 * Focused unit contract for the Phase 5 watch lifecycle + alert inbox
 * service (post binding-review). In-memory Prisma stubs; every test pins one
 * invariant:
 *   * all reads/writes under withTenant with explicit tenantId predicates;
 *   * guessed cross-tenant ids 404 identically;
 *   * source states are created from the VALIDATED configured family
 *     allowlist, not a hardcoded list — a deferred family gets no row;
 *   * the effective activation owner (input → prospect owner → actor) is
 *     revalidated; a departed prospect owner falls back to the actor;
 *   * real changes bump preferenceVersion; no-ops do not;
 *   * unreadOnly filters at the query against real delivery rows;
 *   * read/dismiss preserve FIRST timestamps and write activity only on the
 *     first transition; an existing frozen-recipient delivery authorizes;
 *   * read-all uses one bounded updateMany and never manufactures delivery;
 *   * the tenant inbox is delivery-centric, not current-owner-centric.
 */

const tenantId = randomUUID();
const userId = randomUUID();
const ownerUserId = randomUUID();
const departedOwnerId = randomUUID();
const prospectId = randomUUID();
const watchId = randomUUID();
const alertId = randomUUID();

const ctx: TenantContext = {
  tenantId,
  userId,
  role: 'standard_user',
  tenantSlug: 'test',
} as unknown as TenantContext;

const prospects: Record<
  string,
  { id: string; tenantId: string; ownerUserId: string | null; watchRequested: boolean }
> = {
  [prospectId]: { id: prospectId, tenantId, ownerUserId, watchRequested: false },
};

interface WatchRow {
  id: string;
  tenantId: string;
  prospectId: string;
  ownerUserId: string | null;
  status: string;
  mutedUntil: Date | null;
  categories: string[];
  preferenceVersion: number;
  requestedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AlertRow {
  id: string;
  tenantId: string;
  watchId: string;
  prospectId: string;
  sourceFamily: string;
  category: string;
  materiality: string;
  title: string;
  summary: string;
  implication: string;
  sourceLocator: string;
  firstObservedAt: Date;
  deliveries?: unknown;
}
interface DeliveryRow {
  id: string;
  tenantId: string;
  alertId: string;
  recipientUserId: string;
  channel: string;
  readAt: Date | null;
  dismissedAt: Date | null;
  dismissedByUserId: string | null;
}

function makeService(opts: { activeMemberIds?: string[]; families?: string } = {}) {
  const activeMembers = new Set(opts.activeMemberIds ?? [userId, ownerUserId]);
  const families = opts.families ?? 'federal_award,federal_assistance_award,sam_opportunity,tango_resource,lda_filing';

  const watches: WatchRow[] = [];
  const states: Array<{ id: string; tenantId: string; watchId: string; sourceFamily: string; health: string }> = [];
  const alerts: AlertRow[] = [];
  const deliveries: DeliveryRow[] = [];
  const activities: unknown[] = [];
  const auditLogs: unknown[] = [];
  let deliverySeq = 0;

  const findWatch = (t: string, p: string) => watches.find((w) => w.tenantId === t && w.prospectId === p);

  const tx = {
    businessDevelopmentProspect: {
      findFirst: jest.fn(async ({ where }: { where: { tenantId: string; id: string } }) => {
        const p = prospects[where.id];
        return p && p.tenantId === where.tenantId ? p : null;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: { where: { tenantId_id: { tenantId: string; id: string } }; data: { watchRequested?: boolean } }) => {
          const p = prospects[where.tenantId_id.id];
          if (p && p.tenantId === where.tenantId_id.tenantId && data.watchRequested !== undefined) {
            p.watchRequested = data.watchRequested;
          }
          return p;
        },
      ),
    },
    tenantMembership: {
      findFirst: jest.fn(
        async ({
          where,
        }: { where: { tenantId: string; userId: string; status: string } }) =>
          where.tenantId === tenantId && activeMembers.has(where.userId) && where.status === 'active'
            ? { id: randomUUID() }
            : null,
      ),
    },
    businessDevelopmentWatch: {
      findFirst: jest.fn(
        async ({
          where,
        }: { where: { tenantId: string; prospectId?: string; ownerUserId?: string } }) => {
          if (where.prospectId) return findWatch(where.tenantId, where.prospectId) ?? null;
          return (
            watches.find(
              (w) => w.tenantId === where.tenantId && (!where.ownerUserId || w.ownerUserId === where.ownerUserId),
            ) ?? null
          );
        },
      ),
      findMany: jest.fn(
        async ({ where }: { where: { tenantId: string; ownerUserId?: string } }) =>
          watches.filter(
            (w) => w.tenantId === where.tenantId && (!where.ownerUserId || w.ownerUserId === where.ownerUserId),
          ),
      ),
      create: jest.fn(async ({ data }: { data: Partial<WatchRow> }) => {
        const row: WatchRow = {
          id: watchId,
          tenantId: data.tenantId!,
          prospectId: data.prospectId!,
          ownerUserId: data.ownerUserId ?? null,
          status: data.status ?? 'active',
          mutedUntil: data.mutedUntil ?? null,
          categories: data.categories ?? [],
          preferenceVersion: data.preferenceVersion ?? 1,
          requestedByUserId: data.requestedByUserId ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        watches.push(row);
        return row;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: { where: { id: string }; data: Record<string, unknown> & { preferenceVersion?: { increment: number } } }) => {
          const w = watches.find((x) => x.id === where.id);
          if (!w) throw new Error('watch not found');
          if (data.preferenceVersion && typeof data.preferenceVersion === 'object') {
            w.preferenceVersion += data.preferenceVersion.increment;
          }
          for (const k of ['status', 'mutedUntil', 'categories', 'ownerUserId'] as const) {
            if (k in data) (w as unknown as Record<string, unknown>)[k] = data[k];
          }
          return w;
        },
      ),
    },
    businessDevelopmentWatchSourceState: {
      findMany: jest.fn(
        async ({ where }: { where: { tenantId: string; watchId: string } }) =>
          states.filter((s) => s.tenantId === where.tenantId && s.watchId === where.watchId),
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { tenantId_watchId_sourceFamily: { tenantId: string; watchId: string; sourceFamily: string } };
          create: { tenantId: string; watchId: string; sourceFamily: string; health: string };
        }) => {
          const k = where.tenantId_watchId_sourceFamily;
          let s = states.find((x) => x.tenantId === k.tenantId && x.watchId === k.watchId && x.sourceFamily === k.sourceFamily);
          if (!s) {
            s = { id: randomUUID(), ...k, health: create.health };
            states.push(s);
          }
          return s;
        },
      ),
    },
    businessDevelopmentAlert: {
      findFirst: jest.fn(
        async ({
          where,
        }: { where: { tenantId: string; prospectId?: string; id?: string } }) => {
          if (where.id) {
            const a = alerts.find((x) => x.tenantId === where.tenantId && x.id === where.id);
            return a && (!where.prospectId || a.prospectId === where.prospectId) ? a : null;
          }
          return null;
        },
      ),
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            tenantId: string;
            prospectId?: string;
            watchId?: { in: string[] };
            deliveries?: {
              some: { recipientUserId: string; channel: string; readAt?: null; dismissedAt?: null };
            };
          };
        }) =>
          alerts
            .filter(
              (a) =>
                a.tenantId === where.tenantId &&
                (!where.prospectId || a.prospectId === where.prospectId) &&
                (!where.watchId || where.watchId.in.includes(a.watchId)),
            )
            .filter((a) => {
              if (!where.deliveries) return true;
              // delivery-centric: an EXISTING in_app delivery for this
              // recipient defines membership; unread conditions apply when
              // present.
              return deliveries.some(
                (d) =>
                  d.alertId === a.id &&
                  d.recipientUserId === where.deliveries!.some.recipientUserId &&
                  d.channel === where.deliveries!.some.channel &&
                  (where.deliveries!.some.readAt === undefined || d.readAt === null) &&
                  (where.deliveries!.some.dismissedAt === undefined || d.dismissedAt === null),
              );
            })
            .sort((a, b) => b.firstObservedAt.getTime() - a.firstObservedAt.getTime())
            .map((a) => ({
              ...a,
              eventAt: null,
              effectiveAt: null,
              publishedAt: null,
              deliveries: deliveries
                .filter(
                  (d) =>
                    d.alertId === a.id &&
                    d.recipientUserId === (where.deliveries?.some.recipientUserId ?? userId) &&
                    d.channel === 'in_app',
                )
                .map((d) => ({ readAt: d.readAt, dismissedAt: d.dismissedAt })),
              watch: { prospect: { displayName: 'Acme Corp' } },
            })),
      ),
      count: jest.fn(
        async ({
          where,
        }: {
          where: {
            tenantId: string;
            prospectId?: string;
            watchId?: { in: string[] };
            deliveries?: {
              some: { recipientUserId: string; channel: string; readAt?: null; dismissedAt?: null };
            };
          };
        }) =>
          alerts.filter(
            (a) =>
              a.tenantId === where.tenantId &&
              (!where.prospectId || a.prospectId === where.prospectId) &&
              (!where.watchId || where.watchId.in.includes(a.watchId)) &&
              (!where.deliveries ||
                deliveries.some(
                  (d) =>
                    d.alertId === a.id &&
                    d.recipientUserId === where.deliveries!.some.recipientUserId &&
                    d.channel === where.deliveries!.some.channel &&
                    (where.deliveries!.some.readAt === undefined || d.readAt === null) &&
                    (where.deliveries!.some.dismissedAt === undefined || d.dismissedAt === null),
                )),
          ).length,
      ),
    },
    businessDevelopmentAlertDelivery: {
      findUnique: jest.fn(
        async ({
          where,
        }: { where: { tenantId_alertId_recipientUserId_channel: { tenantId: string; alertId: string; recipientUserId: string; channel: string } } }) => {
          const k = where.tenantId_alertId_recipientUserId_channel;
          return (
            deliveries.find(
              (d) =>
                d.tenantId === k.tenantId && d.alertId === k.alertId && d.recipientUserId === k.recipientUserId && d.channel === k.channel,
            ) ?? null
          );
        },
      ),
      findMany: jest.fn(
        async ({ where }: { where: { tenantId: string; alertId?: { in: string[] }; recipientUserId: string; channel: string } }) =>
          deliveries.filter(
            (d) =>
              d.tenantId === where.tenantId &&
              (!where.alertId || where.alertId.in.includes(d.alertId)) &&
              d.recipientUserId === where.recipientUserId &&
              d.channel === where.channel,
          ),
      ),
      create: jest.fn(async ({ data }: { data: Partial<DeliveryRow> }) => {
        const row: DeliveryRow = {
          id: `d${++deliverySeq}`,
          tenantId: data.tenantId!,
          alertId: data.alertId!,
          recipientUserId: data.recipientUserId!,
          channel: data.channel ?? 'in_app',
          readAt: data.readAt ?? null,
          dismissedAt: data.dismissedAt ?? null,
          dismissedByUserId: data.dismissedByUserId ?? null,
        };
        deliveries.push(row);
        return row;
      }),
      createMany: jest.fn(async ({ data }: { data: Partial<DeliveryRow>[] }) => {
        for (const d of data) {
          deliveries.push({
            id: `d${++deliverySeq}`,
            tenantId: d.tenantId!,
            alertId: d.alertId!,
            recipientUserId: d.recipientUserId!,
            channel: d.channel ?? 'in_app',
            readAt: d.readAt ?? null,
            dismissedAt: d.dismissedAt ?? null,
            dismissedByUserId: d.dismissedByUserId ?? null,
          });
        }
        return { count: data.length };
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: {
            tenantId: string;
            alertId: string | { in: string[] };
            recipientUserId: string;
            channel?: string;
            readAt?: null;
            dismissedAt?: null;
          };
          data: { readAt?: Date; dismissedAt?: Date; dismissedByUserId?: string | null };
        }) => {
          const ids = typeof where.alertId === 'string' ? [where.alertId] : where.alertId.in;
          let n = 0;
          for (const d of deliveries) {
            if (
              d.tenantId === where.tenantId &&
              ids.includes(d.alertId) &&
              d.recipientUserId === where.recipientUserId &&
              (where.channel === undefined || d.channel === where.channel) &&
              (where.readAt === undefined ? true : d.readAt === null) &&
              (where.dismissedAt === undefined ? true : d.dismissedAt === null)
            ) {
              if (data.readAt !== undefined) d.readAt = data.readAt;
              if (data.dismissedAt !== undefined) d.dismissedAt = data.dismissedAt;
              if (data.dismissedByUserId !== undefined) d.dismissedByUserId = data.dismissedByUserId;
              n += 1;
            }
          }
          return { count: n };
        },
      ),
      findUniqueOrThrow: jest.fn(
        async ({
          where,
        }: { where: { tenantId_alertId_recipientUserId_channel: { tenantId: string; alertId: string; recipientUserId: string; channel: string } } }) => {
          const k = where.tenantId_alertId_recipientUserId_channel;
          const d = deliveries.find(
            (x) =>
              x.tenantId === k.tenantId && x.alertId === k.alertId && x.recipientUserId === k.recipientUserId && x.channel === k.channel,
          );
          if (!d) throw new Error('delivery not found');
          return d;
        },
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { tenantId_alertId_recipientUserId_channel: { tenantId: string; alertId: string; recipientUserId: string; channel: string } };
          create: Partial<DeliveryRow>;
          update: Record<string, unknown>;
        }) => {
          const k = where.tenantId_alertId_recipientUserId_channel;
          let d = deliveries.find(
            (x) => x.tenantId === k.tenantId && x.alertId === k.alertId && x.recipientUserId === k.recipientUserId && x.channel === k.channel,
          );
          if (!d) {
            d = {
              id: `d${++deliverySeq}`,
              ...k,
              readAt: create.readAt ?? null,
              dismissedAt: create.dismissedAt ?? null,
              dismissedByUserId: create.dismissedByUserId ?? null,
            };
            deliveries.push(d);
          } else if (Object.keys(update).length > 0) {
            if (update.readAt && typeof update.readAt === 'object' && 'set' in update.readAt) {
              d.readAt = update.readAt.set as Date;
            }
            if (update.dismissedAt && typeof update.dismissedAt === 'object' && 'set' in update.dismissedAt) {
              d.dismissedAt = update.dismissedAt.set as Date;
            }
            if ('dismissedByUserId' in update) d.dismissedByUserId = update.dismissedByUserId as string | null;
          }
          return d;
        },
      ),
    },
    $executeRaw: jest.fn(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const [readAt, dismissedAt, dismissedByUserId, rowTenantId, rowAlertId, recipientUserId] =
          values as [Date, Date, string, string, string, string];
        const delivery = deliveries.find(
          (d) =>
            d.tenantId === rowTenantId &&
            d.alertId === rowAlertId &&
            d.recipientUserId === recipientUserId &&
            d.channel === 'in_app' &&
            d.dismissedAt === null,
        );
        if (!delivery) return 0;
        delivery.readAt ??= readAt;
        delivery.dismissedAt = dismissedAt;
        delivery.dismissedByUserId = dismissedByUserId;
        return 1;
      },
    ),
    businessDevelopmentProspectActivity: {
      create: jest.fn(async ({ data }: { data: unknown }) => {
        activities.push(data);
        return data;
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: unknown }) => {
        auditLogs.push(data);
        return data;
      }),
    },
  };

  const prisma = {
    withTenant: jest.fn(async (t: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as never;

  const config = {
    get: jest.fn((_key: string) => families),
  } as never;

  return {
    svc: new BizDevWatchService(prisma, config),
    tx,
    watches,
    states,
    alerts,
    deliveries,
    activities,
    auditLogs,
    prisma,
  };
}

beforeEach(() => {
  prospects[prospectId]!.ownerUserId = ownerUserId;
  prospects[prospectId]!.watchRequested = false;
});

describe('activateWatch', () => {
  test('creates watch + pending source states from the VALIDATED configured allowlist; deferred family absent', async () => {
    const env = makeService({ families: 'federal_award,lda_filing' });
    const res = await env.svc.activateWatch(ctx, prospectId, {});
    expect(res.watch?.status).toBe('active');
    expect(env.states.map((s) => s.sourceFamily).sort()).toEqual(['federal_award', 'lda_filing']);
    expect(env.states.every((s) => s.health === 'pending')).toBe(true);
    expect(prospects[prospectId]!.watchRequested).toBe(true);
    expect(env.activities).toHaveLength(1);
    expect(env.auditLogs).toHaveLength(1);
  });

  test('default allowlist is the five live families (no deferred acquisition_revision)', async () => {
    const env = makeService();
    await env.svc.activateWatch(ctx, prospectId, {});
    expect(env.states.map((s) => s.sourceFamily).sort()).toEqual([
      'federal_assistance_award',
      'federal_award',
      'lda_filing',
      'sam_opportunity',
      'tango_resource',
    ]);
  });

  test('unknown configured family fails closed (no watch activated)', async () => {
    const env = makeService({ families: 'federal_award,made_up_family' });
    await expect(env.svc.activateWatch(ctx, prospectId, {})).rejects.toThrow(Error);
    expect(env.watches).toHaveLength(0);
  });

  test('prospect owner fallback revalidated: departed prospect owner → actor fallback', async () => {
    prospects[prospectId]!.ownerUserId = departedOwnerId;
    const env = makeService({ activeMemberIds: [userId] });
    const res = await env.svc.activateWatch(ctx, prospectId, {});
    expect(res.watch?.ownerUserId).toBe(userId);
  });

  test('explicit inactive owner input 400 (no silent actor substitution)', async () => {
    const env = makeService({ activeMemberIds: [userId] });
    await expect(env.svc.activateWatch(ctx, prospectId, { ownerUserId: ownerUserId })).rejects.toThrow(
      BadRequestException,
    );
  });

  test('no-op re-activation bumps nothing and writes no duplicate activity/audit', async () => {
    const env = makeService();
    await env.svc.activateWatch(ctx, prospectId, {});
    const version = env.watches[0]!.preferenceVersion;
    await env.svc.activateWatch(ctx, prospectId, {});
    expect(env.watches[0]!.preferenceVersion).toBe(version);
    expect(env.activities).toHaveLength(1);
    expect(env.auditLogs).toHaveLength(1);
  });

  test('guessed prospect id 404s', async () => {
    const env = makeService();
    await expect(env.svc.activateWatch(ctx, randomUUID(), {})).rejects.toThrow(NotFoundException);
  });
});

describe('updateWatch', () => {
  test('empty body 400', async () => {
    const env = makeService();
    await expect(env.svc.updateWatch(ctx, prospectId, {})).rejects.toThrow(BadRequestException);
  });

  test('missing watch 404', async () => {
    const env = makeService();
    await expect(env.svc.updateWatch(ctx, prospectId, { status: 'paused' })).rejects.toThrow(
      NotFoundException,
    );
  });

  test('pause bumps preferenceVersion once; no-op pause bumps nothing', async () => {
    const env = makeService();
    await env.svc.activateWatch(ctx, prospectId, {});
    const before = env.watches[0]!.preferenceVersion;
    await env.svc.updateWatch(ctx, prospectId, { status: 'paused' });
    expect(env.watches[0]!.preferenceVersion).toBe(before + 1);
    const pausedAt = env.watches[0]!.preferenceVersion;
    // Same status again = no-op
    await env.svc.updateWatch(ctx, prospectId, { status: 'paused' });
    expect(env.watches[0]!.preferenceVersion).toBe(pausedAt);
  });

  test('resume clears mutedUntil (no accumulated replay)', async () => {
    const env = makeService();
    await env.svc.activateWatch(ctx, prospectId, {});
    await env.svc.updateWatch(ctx, prospectId, { mutedUntil: '2099-01-01T00:00:00.000Z' });
    expect(env.watches[0]!.mutedUntil).not.toBeNull();
    const res = await env.svc.updateWatch(ctx, prospectId, { status: 'active' });
    expect(env.watches[0]!.mutedUntil).toBeNull();
    expect(res.watch?.mutedUntil).toBeNull();
  });

  test('end clears the legacy watchRequested bit', async () => {
    const env = makeService();
    await env.svc.activateWatch(ctx, prospectId, {});
    expect(prospects[prospectId]!.watchRequested).toBe(true);
    await env.svc.updateWatch(ctx, prospectId, { status: 'ended' });
    expect(prospects[prospectId]!.watchRequested).toBe(false);
  });

  test('resume (paused/ended → active) RESTORES the legacy watchRequested bit', async () => {
    const env = makeService();
    await env.svc.activateWatch(ctx, prospectId, {});
    await env.svc.updateWatch(ctx, prospectId, { status: 'ended' });
    expect(prospects[prospectId]!.watchRequested).toBe(false);
    await env.svc.updateWatch(ctx, prospectId, { status: 'active' });
    expect(prospects[prospectId]!.watchRequested).toBe(true);
    // paused → active also restores it
    await env.svc.updateWatch(ctx, prospectId, { status: 'paused' });
    await env.svc.updateWatch(ctx, prospectId, { status: 'active' });
    expect(prospects[prospectId]!.watchRequested).toBe(true);
  });

  test('owner change validates ACTIVE membership', async () => {
    const env = makeService({ activeMemberIds: [userId] });
    await env.svc.activateWatch(ctx, prospectId, {});
    await expect(env.svc.updateWatch(ctx, prospectId, { ownerUserId: ownerUserId })).rejects.toThrow(
      BadRequestException,
    );
  });

  test('invalid mutedUntil 400', async () => {
    const env = makeService();
    await env.svc.activateWatch(ctx, prospectId, {});
    await expect(
      env.svc.updateWatch(ctx, prospectId, { mutedUntil: 'not-a-date' }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('alert inbox', () => {
  const seedAlert = (
    env: ReturnType<typeof makeService>,
    over: Partial<AlertRow> = {},
    recipientUserId: string | null = userId,
  ) => {
    const row: AlertRow = {
      id: alertId,
      tenantId,
      watchId,
      prospectId,
      sourceFamily: 'federal_award',
      category: 'contract_award',
      materiality: 'high',
      title: 'New federal award',
      summary: 's',
      implication: 'i',
      sourceLocator: 'https://www.usaspending.gov/award/x',
      firstObservedAt: new Date('2026-09-01T00:00:00Z'),
      ...over,
    };
    env.alerts.push(row);
    if (recipientUserId) {
      env.deliveries.push({
        id: randomUUID(),
        tenantId,
        alertId: row.id,
        recipientUserId,
        channel: 'in_app',
        readAt: null,
        dismissedAt: null,
        dismissedByUserId: null,
      });
    }
  };

  test('listProspectAlerts pages newest-first with unreadCount', async () => {
    const env = makeService();
    seedAlert(env);
    seedAlert(env, { id: randomUUID(), title: 'older', firstObservedAt: new Date('2026-08-01T00:00:00Z') });
    const res = await env.svc.listProspectAlerts(ctx, prospectId, { limit: 1 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.title).toBe('New federal award');
    expect(res.nextCursor).toBeTruthy();
    expect(res.unreadCount).toBe(2);
  });

  test('unreadOnly filters at the query (read alerts excluded)', async () => {
    const env = makeService();
    seedAlert(env);
    seedAlert(env, { id: randomUUID(), title: 'second' });
    await env.svc.markAlertRead(ctx, prospectId, alertId);
    const res = await env.svc.listProspectAlerts(ctx, prospectId, { unreadOnly: true });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.title).toBe('second');
    expect(res.unreadCount).toBe(1);
  });

  test('dismissed alerts are excluded from unreadOnly and unread count', async () => {
    const env = makeService();
    seedAlert(env);
    seedAlert(env, { id: randomUUID(), title: 'unread' });
    await env.svc.dismissAlert(ctx, prospectId, alertId);
    const res = await env.svc.listProspectAlerts(ctx, prospectId, { unreadOnly: true });
    expect(res.items.map((i) => i.title)).toEqual(['unread']);
    expect(res.unreadCount).toBe(1);
  });

  test('guessed cross-tenant prospect 404s', async () => {
    const env = makeService();
    await expect(env.svc.listProspectAlerts(ctx, randomUUID(), {})).rejects.toThrow(NotFoundException);
  });

  test('markAlertRead preserves FIRST readAt and writes activity only once', async () => {
    const env = makeService();
    seedAlert(env);
    const first = await env.svc.markAlertRead(ctx, prospectId, alertId);
    expect(env.activities).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    const second = await env.svc.markAlertRead(ctx, prospectId, alertId);
    expect(second.readAt).toBe(first.readAt); // first timestamp preserved
    expect(env.activities).toHaveLength(1); // activity only on first transition
    expect(env.deliveries).toHaveLength(1);
  });

  test('dismissAlert implies read, preserves first timestamps, idempotent', async () => {
    const env = makeService();
    seedAlert(env);
    const read = await env.svc.markAlertRead(ctx, prospectId, alertId);
    await new Promise((r) => setTimeout(r, 5));
    const dismissed = await env.svc.dismissAlert(ctx, prospectId, alertId);
    expect(dismissed.readAt).toBe(read.readAt); // readAt not overwritten
    expect(env.activities).toHaveLength(2); // read + first dismissal
    const again = await env.svc.dismissAlert(ctx, prospectId, alertId);
    expect(again.dismissedAt).toBe(dismissed.dismissedAt);
    expect(env.activities).toHaveLength(2);
    expect(env.deliveries).toHaveLength(1);
  });

  test('concurrent read retries transition once and append one activity', async () => {
    const env = makeService();
    seedAlert(env);
    const [a, b] = await Promise.all([
      env.svc.markAlertRead(ctx, prospectId, alertId),
      env.svc.markAlertRead(ctx, prospectId, alertId),
    ]);
    expect(a.readAt).toBe(b.readAt);
    expect(env.activities).toHaveLength(1);
  });

  test('dismiss uses atomic COALESCE update and preserves an earlier read timestamp', async () => {
    const env = makeService();
    seedAlert(env);
    const read = await env.svc.markAlertRead(ctx, prospectId, alertId);
    const dismissed = await env.svc.dismissAlert(ctx, prospectId, alertId);
    expect(dismissed.readAt).toBe(read.readAt);
    expect(env.tx.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = (env.tx.$executeRaw as jest.Mock).mock.calls[0]![0].join(' ');
    expect(sql).toContain('COALESCE("read_at"');
  });

  test('frozen delivery recipient may mutate; current owner without a delivery gets 403', async () => {
    const env = makeService();
    seedAlert(env);
    await env.svc.markAlertRead(ctx, prospectId, alertId);
    const ownerCtx = { ...ctx, userId: ownerUserId } as TenantContext;
    await expect(env.svc.dismissAlert(ownerCtx, prospectId, alertId)).rejects.toThrow(
      ForbiddenException,
    );
  });

  test('missing delivery is never manufactured and returns 403', async () => {
    const env = makeService();
    seedAlert(env, {}, null);
    await expect(env.svc.markAlertRead(ctx, prospectId, alertId)).rejects.toThrow(
      ForbiddenException,
    );
    expect(env.deliveries).toHaveLength(0);
  });

  test('cross-prospect alertId 404s', async () => {
    const env = makeService();
    seedAlert(env);
    await expect(env.svc.markAlertRead(ctx, prospectId, randomUUID())).rejects.toThrow(NotFoundException);
  });

  test('tenant inbox lists only alerts delivered to the current recipient', async () => {
    const env = makeService();
    seedAlert(env);
    const otherWatchId = randomUUID();
    env.watches.push({
      id: otherWatchId,
      tenantId,
      prospectId: randomUUID(),
      ownerUserId: ownerUserId,
      status: 'active',
      mutedUntil: null,
      categories: [],
      preferenceVersion: 1,
      requestedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    env.alerts.push({
      id: randomUUID(),
      tenantId,
      watchId: otherWatchId,
      prospectId: randomUUID(),
      sourceFamily: 'lda_filing',
      category: 'lobbying',
      materiality: 'low',
      title: 'not mine',
      summary: 's',
      implication: 'i',
      sourceLocator: 'https://lda.senate.gov/system/lod/x',
      firstObservedAt: new Date('2026-09-02T00:00:00Z'),
    });
    const res = await env.svc.listTenantAlerts(ctx, {});
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.title).toBe('New federal award');
    expect(res.unreadCount).toBe(1);
  });

  test('read-all is bounded bulk and never manufactures delivery rows', async () => {
    const env = makeService();
    seedAlert(env);
    seedAlert(env, { id: randomUUID(), title: 'b' });
    const res = await env.svc.markAllAlertsRead(ctx);
    expect(res.marked).toBe(2);
    expect(env.deliveries).toHaveLength(2);
    expect(env.deliveries.every((d) => d.readAt != null)).toBe(true);
    expect(env.tx.businessDevelopmentAlertDelivery.updateMany).toHaveBeenCalledTimes(1);
    expect(env.tx.businessDevelopmentAlertDelivery.createMany).toHaveBeenCalledTimes(0);
    expect(env.tx.businessDevelopmentAlertDelivery.create).toHaveBeenCalledTimes(0);
    // Idempotent: second run is a no-op
    await env.svc.markAllAlertsRead(ctx);
    expect(env.deliveries).toHaveLength(2);
  });
});

describe('cursor codec', () => {
  test('round-trips and rejects malformed cursors', () => {
    const ts = new Date('2026-09-25T12:00:00.000Z');
    const c = encodeCursor(ts, 'abc');
    const [back, id] = decodeCursor(c);
    expect(back.toISOString()).toBe(ts.toISOString());
    expect(id).toBe('abc');
    expect(() => decodeCursor('!!!not-a-cursor!!!')).toThrow(BadRequestException);
  });
});
