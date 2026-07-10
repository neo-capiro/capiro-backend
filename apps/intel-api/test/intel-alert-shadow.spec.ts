import { clearsMateriality, isWithinQuietHours } from '../src/intel-alert/intel-alert.types.js';
import { IntelAlertService } from '../src/intel-alert/intel-alert.service.js';
import type { IntelAlertEvent } from '../src/intel-alert/intel-alert.types.js';

describe('clearsMateriality', () => {
  it('passes when severity rank >= materiality floor', () => {
    expect(clearsMateriality('critical', 'high')).toBe(true);
    expect(clearsMateriality('notable', 'high')).toBe(false);
    expect(clearsMateriality('notable', 'medium')).toBe(true);
    expect(clearsMateriality('info', 'low')).toBe(true);
    expect(clearsMateriality('info', 'medium')).toBe(false);
  });
});

describe('isWithinQuietHours', () => {
  // 03:00 ET
  const at3amEt = new Date('2026-03-10T08:00:00Z'); // 08:00 UTC = 03:00 EST
  it('handles the midnight-wrap window 22:00–07:00', () => {
    expect(isWithinQuietHours('22:00', '07:00', at3amEt)).toBe(true);
    expect(isWithinQuietHours('07:00', '22:00', at3amEt)).toBe(false);
  });
  it('returns false when unset/invalid', () => {
    expect(isWithinQuietHours(null, '07:00', at3amEt)).toBe(false);
  });
});

/**
 * The single-sender shadow guarantee (plan §7.4 / S2): fanOut for a NOT-owned
 * tenant with the kill-switch off must claim `suppressed_shadow` and NEVER call
 * email.send(). The mock prisma provides withTenant/withSystem shims that just
 * run the callback with the mock as the tx (the real ones open a SET LOCAL tx).
 */
describe('IntelAlertService.fanOut (shadow)', () => {
  const event: IntelAlertEvent = {
    tenantId: 't1',
    clientId: 'c1',
    billId: '119-hr-1',
    displayNum: 'H.R. 1',
    billTitle: 'Test',
    changeType: 'bill_amendment',
    triggerKey: 'amendment',
    label: 'Amended',
    severity: 'notable',
    detail: 'Amended',
    actionDate: null,
    url: '',
    matchedTags: [],
    score: 0.5,
    band: 'Med',
  };

  function makeService(owned: boolean, triggers: string[] = ['amendment']) {
    const claims: Array<{ status: string; channel: string }> = [];
    const sendCalls: string[] = [];
    const inner = {
      intelAlertPreference: {
        findMany: async () => [
          {
            userId: 'u1',
            triggers,
            materiality: 'medium',
            emailEnabled: true,
            emailAddress: 'u1@x.com',
          },
        ],
      },
      intelNotificationLog: {
        create: async ({ data }: { data: { status: string; channel: string } }) => {
          claims.push({ status: data.status, channel: data.channel });
          return { id: 'log1' };
        },
        update: async () => ({}),
      },
    };
    const prisma = {
      ...inner,
      withTenant: async <T>(_tid: string, cb: (tx: typeof inner) => Promise<T>) => cb(inner),
      withSystem: async <T>(cb: (tx: typeof inner) => Promise<T>) => cb(inner),
    };
    const flags = { isEnabled: async () => owned };
    const email = {
      send: async (to: string) => {
        sendCalls.push(to);
        return { sent: true, messageId: 'm1' };
      },
    };
    const svc = new IntelAlertService(prisma as never, flags as never, email as never);
    return { svc, claims, sendCalls };
  }

  it('suppresses (no send) when not owned', async () => {
    delete process.env.TRACKER_ALERTS_ENABLED;
    const { svc, claims, sendCalls } = makeService(false);
    const r = await svc.fanOut(event);
    expect(r).toEqual({ suppressed: 1, sent: 0, failed: 0 });
    expect(claims).toEqual([{ status: 'suppressed_shadow', channel: 'email' }]);
    expect(sendCalls).toEqual([]); // NEVER sent
  });

  it('suppresses even when owned if the TRACKER_ALERTS_ENABLED kill-switch is off', async () => {
    delete process.env.TRACKER_ALERTS_ENABLED; // kill-switch off (shadow default)
    const { svc, claims, sendCalls } = makeService(true); // owned (e.g. internal tenant)
    const r = await svc.fanOut(event);
    expect(r.sent).toBe(0);
    expect(sendCalls).toEqual([]); // still NEVER sent — kill-switch wins
    expect(claims[0].status).toBe('suppressed_shadow');
  });

  it('skips prefs that fail the trigger/materiality gate', async () => {
    delete process.env.TRACKER_ALERTS_ENABLED;
    const { svc, claims } = makeService(false, ['hearing']); // event.triggerKey='amendment' ∉ ['hearing']
    const r = await svc.fanOut(event);
    expect(r).toEqual({ suppressed: 0, sent: 0, failed: 0 });
    expect(claims).toEqual([]);
  });
});

/**
 * LegiWatch B (plan §7 SC6): emitNewBillAlerts must STAMP deliveredAt so a
 * re-run reprocesses nothing — the idempotency fix for the old read-but-never-
 * written gap.
 */
describe('IntelAlertService.emitNewBillAlerts (idempotency)', () => {
  function makeEmitService() {
    const alertRow = {
      id: 'a1',
      tenantId: 't1',
      clientId: 'c1',
      sourceType: 'bill',
      sourceRef: '119-hr-1',
      status: 'new',
      deliveredAt: null as Date | null,
      changeType: 'bill_fiscal_note',
      kind: 'bill_fiscal_note',
      severity: 'notable',
      score: 0.5,
      title: 'H.R. 1',
      whyItMatters: null,
      evidence: { triggerKey: 'fiscalNote', displayNum: 'H.R. 1', stage: 'New CBO cost estimate' },
    };
    const store = [alertRow];
    const updates: Array<{ id: string; deliveredAt: Date | null }> = [];
    const inner = {
      intelAlert: {
        findMany: async () => store.filter((r) => r.status === 'new' && r.deliveredAt == null),
        update: async ({ where, data }: { where: { id: string }; data: { deliveredAt: Date } }) => {
          const row = store.find((r) => r.id === where.id)!;
          row.deliveredAt = data.deliveredAt;
          updates.push({ id: where.id, deliveredAt: data.deliveredAt });
          return row;
        },
      },
      intelAlertPreference: { findMany: async () => [] }, // no subscribers → pure processing path
      intelNotificationLog: { create: async () => ({ id: 'l' }), update: async () => ({}) },
    };
    const prisma = {
      ...inner,
      withTenant: async <T>(_t: string, cb: (tx: typeof inner) => Promise<T>) => cb(inner),
      withSystem: async <T>(cb: (tx: typeof inner) => Promise<T>) => cb(inner),
    };
    const svc = new IntelAlertService(
      prisma as never,
      { isEnabled: async () => false } as never,
      { send: async () => ({ sent: true }) } as never,
    );
    return { svc, store, updates };
  }

  it('stamps deliveredAt and a re-run processes zero rows', async () => {
    delete process.env.TRACKER_ALERTS_ENABLED;
    const { svc, store, updates } = makeEmitService();
    const first = await svc.emitNewBillAlerts();
    expect(first.alerts).toBe(1);
    expect(first.failed).toBe(0);
    expect(store[0].deliveredAt).toBeInstanceOf(Date); // stamped
    expect(updates).toHaveLength(1);

    const second = await svc.emitNewBillAlerts(); // re-run
    expect(second.alerts).toBe(0); // deliveredAt filter now excludes it — no dup work
  });
});

describe('IntelAlertService.backfillDefaultTriggers', () => {
  it('appends fiscalNote + sponsorMomentum + deadline exactly once, idempotently', async () => {
    const calls: Array<{ sql: string; key: string }> = [];
    const inner = {
      $executeRawUnsafe: async (sql: string, key: string) => {
        calls.push({ sql, key });
        return 3; // rows touched
      },
    };
    const prisma = { withSystem: async <T>(cb: (tx: typeof inner) => Promise<T>) => cb(inner) };
    const svc = new IntelAlertService(prisma as never, {} as never, {} as never);
    const r = await svc.backfillDefaultTriggers();
    expect(r.updated).toBe(9); // 3 rows × 3 keys
    expect(calls.map((c) => c.key)).toEqual(['fiscalNote', 'sponsorMomentum', 'deadline']);
    // guard clause makes it a no-op on rows that already have the key
    expect(calls[0].sql).toMatch(/NOT \(\$1 = ANY\(triggers\)\)/);
  });

  // REGRESSION (2026-07-10, W2.1, D-7): `companion` shipped its emitter in
  // Phase-0 (#374), BEFORE this backfill existed — unlike the other 3 keys, a
  // subscriber could have deliberately opted OUT of `companion` since then,
  // and this predicate can't tell that apart from "never had it." Backfilling
  // it here would silently override a real opt-out, so it must never be
  // among the keys this verb touches again.
  it('REGRESSION: never backfills `companion` (D-7) — a real opt-out must not be silently overridden', async () => {
    const calls: Array<{ key: string }> = [];
    const inner = {
      $executeRawUnsafe: async (_sql: string, key: string) => {
        calls.push({ key });
        return 1;
      },
    };
    const prisma = { withSystem: async <T>(cb: (tx: typeof inner) => Promise<T>) => cb(inner) };
    const svc = new IntelAlertService(prisma as never, {} as never, {} as never);
    await svc.backfillDefaultTriggers();
    expect(calls.map((c) => c.key)).not.toContain('companion');
  });
});

// Review finding #6: a soft send failure must NOT stamp deliveredAt (so it
// retries), and the notification-log claim must key on the alert ROW id.
describe('IntelAlertService real-send delivery (finding #1/#6)', () => {
  afterEach(() => {
    delete process.env.TRACKER_ALERTS_ENABLED;
  });

  function makeRealSendService(sendResult: { sent: boolean; error?: string }) {
    const alertRow = {
      id: 'row-1',
      tenantId: 't1',
      clientId: 'c1',
      sourceType: 'bill',
      sourceRef: '119-hr-1',
      status: 'new',
      deliveredAt: null as Date | null,
      changeType: 'bill_fiscal_note',
      kind: 'bill_fiscal_note',
      severity: 'notable',
      score: 0.5,
      title: 'H.R. 1',
      whyItMatters: null,
      evidence: { triggerKey: 'fiscalNote', displayNum: 'H.R. 1', stage: 'New CBO cost estimate' },
    };
    const store = [alertRow];
    const claimedAlertIds: string[] = [];
    const inner = {
      intelAlert: {
        findMany: async () => store.filter((r) => r.status === 'new' && r.deliveredAt == null),
        update: async ({ where, data }: { where: { id: string }; data: { deliveredAt: Date } }) => {
          const row = store.find((r) => r.id === where.id)!;
          row.deliveredAt = data.deliveredAt;
          return row;
        },
      },
      intelAlertPreference: {
        findMany: async () => [
          {
            userId: 'u1',
            triggers: ['fiscalNote'],
            materiality: 'low',
            emailEnabled: true,
            emailAddress: 'u1@x.com',
          },
        ],
      },
      intelNotificationLog: {
        create: async ({ data }: { data: { alertId: string } }) => {
          claimedAlertIds.push(data.alertId);
          return { id: 'log-1' };
        },
        update: async () => ({}),
        findFirst: async () => null,
      },
    };
    const prisma = {
      ...inner,
      withTenant: async <T>(_t: string, cb: (tx: typeof inner) => Promise<T>) => cb(inner),
      withSystem: async <T>(cb: (tx: typeof inner) => Promise<T>) => cb(inner),
    };
    const svc = new IntelAlertService(
      prisma as never,
      { isEnabled: async () => true } as never, // owned
      { send: async () => sendResult } as never,
    );
    return { svc, store, claimedAlertIds };
  }

  it('does NOT stamp deliveredAt on a soft send failure (retried next sweep); claim keys on the row id', async () => {
    process.env.TRACKER_ALERTS_ENABLED = 'true'; // real-send mode
    const { svc, store, claimedAlertIds } = makeRealSendService({ sent: false, error: 'smtp 550' });
    const r = await svc.emitNewBillAlerts();
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(0);
    expect(store[0].deliveredAt).toBeNull(); // left for retry, NOT marked delivered
    // The notification-log claim used the alert ROW id (finding #1), not the
    // deterministic tracker:client:bill:changeType composite.
    expect(claimedAlertIds).toContain('row-1');
    // Re-run still sees it (deliveredAt null) — i.e. it will be retried.
    const again = await svc.emitNewBillAlerts();
    expect(again.alerts).toBe(1);
  });

  it('stamps deliveredAt on a successful send (delivered once, then skipped)', async () => {
    process.env.TRACKER_ALERTS_ENABLED = 'true';
    const { svc, store } = makeRealSendService({ sent: true });
    const r = await svc.emitNewBillAlerts();
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
    expect(store[0].deliveredAt).toBeInstanceOf(Date);
    const again = await svc.emitNewBillAlerts();
    expect(again.alerts).toBe(0); // not reprocessed
  });
});
