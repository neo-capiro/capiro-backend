import { IntelAlertService } from '../src/intel-alert/intel-alert.service.js';
import type { IntelAlertEvent } from '../src/intel-alert/intel-alert.types.js';

/**
 * P0-02, audit test-gap item 2 — real daily/weekly digest delivery. Mirrors
 * intel-alert-shadow.spec.ts's hand-rolled prisma double (no DB, no Nest
 * TestingModule). Two families of fixtures:
 *  - `makeFanOutService` for cases 1-5 (cadence routing inside `fanOut`);
 *  - `makeFlushService` for cases 6-12 (`flushDigests`'s full lifecycle,
 *    including the raw-SQL claim/compensation queries, mocked by pattern-
 *    matching the exact SQL text this file's own `flushDigests` issues).
 */

const EVENT: IntelAlertEvent = {
  tenantId: 't1',
  clientId: 'c1',
  billId: '119-hr-1',
  displayNum: 'H.R. 1',
  billTitle: 'Test Act',
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
  alertRowId: 'row-1',
};

function makeFanOutService(opts: { owned: boolean; emailCadence?: string }) {
  const claims: Array<{ status: string }> = [];
  const digestRows: Array<{
    tenantId: string;
    clientId: string;
    userId: string;
    alertId: string;
    channel: string;
    cadence: string;
  }> = [];
  const notifLog = new Map<string, { id: string; status: string }>();
  const inner = {
    intelAlertPreference: {
      findMany: async () => [
        {
          userId: 'u1',
          triggers: ['amendment'],
          materiality: 'medium',
          jurisdictions: [],
          emailEnabled: true,
          emailAddress: 'u1@x.com',
          emailCadence: opts.emailCadence,
        },
      ],
    },
    intelNotificationLog: {
      create: async ({ data }: { data: { alertId: string; userId: string; channel: string; status: string } }) => {
        const key = `${data.alertId}|${data.userId}|${data.channel}`;
        if (notifLog.has(key)) {
          const e = new Error('unique constraint') as Error & { code?: string };
          e.code = 'P2002';
          throw e;
        }
        const id = `log-${notifLog.size + 1}`;
        notifLog.set(key, { id, status: data.status });
        claims.push({ status: data.status });
        return { id };
      },
      update: async () => ({}),
      findFirst: async () => null,
    },
    intelAlertDigestQueue: {
      create: async ({ data }: { data: (typeof digestRows)[number] }) => {
        digestRows.push(data);
        return data;
      },
    },
  };
  const prisma = {
    ...inner,
    withTenant: async <T>(_t: string, cb: (tx: typeof inner) => Promise<T>) => cb(inner),
    withSystem: async <T>(cb: (tx: typeof inner) => Promise<T>) => cb(inner),
  };
  const flags = { isEnabled: async () => opts.owned };
  const sendCalls: string[] = [];
  const email = {
    send: async (to: string) => {
      sendCalls.push(to);
      return { sent: true, messageId: 'm1' };
    },
  };
  const svc = new IntelAlertService(
    prisma as never,
    flags as never,
    email as never,
    {} as never,
    { configured: false } as never,
  );
  return { svc, claims, digestRows, sendCalls, notifLog };
}

interface QueueRow {
  id: string;
  tenant_id: string;
  user_id: string;
  channel: string;
  client_id: string;
  alert_id: string;
  cadence: string;
  flushed: boolean;
  attempts: number;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

function makeDigestStore(initialRows: QueueRow[]) {
  const rows = [...initialRows];

  async function queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
    if (sql.includes('SET flushed = true')) {
      const [cadence, maxAttempts] = params as [string, number];
      const eligible = rows
        .filter((r) => r.cadence === cadence && !r.flushed && r.attempts < maxAttempts)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .slice(0, 5000);
      for (const r of eligible) r.flushed = true;
      return eligible.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        user_id: r.user_id,
        channel: r.channel,
        client_id: r.client_id,
        alert_id: r.alert_id,
      })) as unknown as T;
    }
    if (sql.startsWith('SELECT id, attempts FROM')) {
      const [ids] = params as [string[]];
      return rows
        .filter((r) => ids.includes(r.id))
        .map((r) => ({ id: r.id, attempts: r.attempts })) as unknown as T;
    }
    throw new Error(`Unhandled $queryRawUnsafe: ${sql}`);
  }

  async function executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
    if (sql.includes('SET delivered_at = now()')) {
      const [ids] = params as [string[]];
      let n = 0;
      for (const r of rows) {
        if (ids.includes(r.id)) {
          r.delivered_at = new Date();
          n += 1;
        }
      }
      return n;
    }
    if (sql.includes('SET flushed = false, attempts = attempts + 1')) {
      const [ids, err] = params as [string[], string];
      let n = 0;
      for (const r of rows) {
        if (ids.includes(r.id)) {
          r.flushed = false;
          r.attempts += 1;
          r.last_error = err;
          n += 1;
        }
      }
      return n;
    }
    throw new Error(`Unhandled $executeRawUnsafe: ${sql}`);
  }

  return { rows, queryRawUnsafe, executeRawUnsafe };
}

interface AlertRow {
  id: string;
  clientId: string;
  sourceRef: string;
  title: string;
  severity: string;
  whyItMatters: string | null;
  recommendedAction: string | null;
  evidence: Record<string, unknown>;
}

function makeFlushService(opts: {
  digestRows: QueueRow[];
  alerts: AlertRow[];
  prefs: Array<{ tenantId: string; userId: string; clientId: string; emailEnabled: boolean; emailAddress: string | null }>;
  owned: boolean;
  killSwitchOn: boolean;
  clientNames?: Map<string, string>;
  sendImpl?: (
    to: string,
    subject: string,
    html: string,
    text: string,
  ) => Promise<{ sent: boolean; error?: string; messageId?: string }>;
}) {
  const store = makeDigestStore(opts.digestRows);
  const notificationLogUpdates: Array<{ where: unknown; data: unknown }> = [];
  const sendCalls: Array<{ to: string; subject: string; html: string; text: string }> = [];

  const inner = {
    intelAlert: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        opts.alerts.filter((a) => where.id.in.includes(a.id)),
    },
    intelAlertPreference: {
      findFirst: async ({ where }: { where: { tenantId: string; userId: string; clientId: string } }) =>
        opts.prefs.find(
          (p) => p.tenantId === where.tenantId && p.userId === where.userId && p.clientId === where.clientId,
        ) ?? null,
    },
    intelNotificationLog: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        notificationLogUpdates.push(args);
        return { count: 1 };
      },
    },
    $queryRawUnsafe: store.queryRawUnsafe,
    $executeRawUnsafe: store.executeRawUnsafe,
  };
  const prisma = {
    ...inner,
    withTenant: async <T>(_t: string, cb: (tx: typeof inner) => Promise<T>) => cb(inner),
    withSystem: async <T>(cb: (tx: typeof inner) => Promise<T>) => cb(inner),
  };
  const flags = { isEnabled: async () => opts.owned };
  if (opts.killSwitchOn) process.env.TRACKER_ALERTS_ENABLED = 'true';
  else delete process.env.TRACKER_ALERTS_ENABLED;
  const email = {
    send: async (to: string, subject: string, html: string, text: string) => {
      sendCalls.push({ to, subject, html, text });
      return opts.sendImpl ? opts.sendImpl(to, subject, html, text) : { sent: true, messageId: 'm1' };
    },
  };
  const sourceData = { getClientNames: async () => opts.clientNames ?? new Map<string, string>() };
  const svc = new IntelAlertService(
    prisma as never,
    flags as never,
    email as never,
    sourceData as never,
    { configured: false } as never,
  );
  return { svc, store, sendCalls, notificationLogUpdates };
}

function queueRow(overrides: Partial<QueueRow>): QueueRow {
  return {
    id: 'q1',
    tenant_id: 't1',
    user_id: 'u1',
    channel: 'email',
    client_id: 'c1',
    alert_id: 'row-1',
    cadence: 'daily',
    flushed: false,
    attempts: 0,
    last_error: null,
    delivered_at: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function alertRow(overrides: Partial<AlertRow>): AlertRow {
  return {
    id: 'row-1',
    clientId: 'c1',
    sourceRef: '119-hr-1',
    title: 'Test Act',
    severity: 'notable',
    whyItMatters: null,
    recommendedAction: null,
    evidence: { displayNum: 'H.R. 1', billTitle: 'Test Act', stage: 'Amended', actionText: 'Amended' },
    ...overrides,
  };
}

describe('IntelAlertService.fanOut — cadence routing (P0-02, cases 1-5)', () => {
  afterEach(() => {
    delete process.env.TRACKER_ALERTS_ENABLED;
  });

  it('1. daily never sends immediately: enqueues, does not call email.send', async () => {
    process.env.TRACKER_ALERTS_ENABLED = 'true';
    const { svc, claims, digestRows, sendCalls } = makeFanOutService({ owned: true, emailCadence: 'daily' });
    const r = await svc.fanOut(EVENT);
    expect(sendCalls).toEqual([]);
    expect(digestRows).toHaveLength(1);
    expect(digestRows[0]!.cadence).toBe('daily');
    expect(claims).toEqual([{ status: 'queued' }]);
    expect(r).toEqual({ suppressed: 0, sent: 0, failed: 0, queued: 1 });
  });

  it('2. weekly never sends immediately: enqueues, does not call email.send', async () => {
    process.env.TRACKER_ALERTS_ENABLED = 'true';
    const { svc, digestRows, sendCalls } = makeFanOutService({ owned: true, emailCadence: 'weekly' });
    const r = await svc.fanOut(EVENT);
    expect(sendCalls).toEqual([]);
    expect(digestRows).toHaveLength(1);
    expect(digestRows[0]!.cadence).toBe('weekly');
    expect(r).toEqual({ suppressed: 0, sent: 0, failed: 0, queued: 1 });
  });

  it('3. realtime still sends immediately (regression lock)', async () => {
    process.env.TRACKER_ALERTS_ENABLED = 'true';
    const { svc, digestRows, sendCalls } = makeFanOutService({ owned: true, emailCadence: 'realtime' });
    const r = await svc.fanOut(EVENT);
    expect(sendCalls).toEqual(['u1@x.com']);
    expect(digestRows).toHaveLength(0);
    expect(r).toEqual({ suppressed: 0, sent: 1, failed: 0, queued: 0 });
  });

  it('4. shadow suppresses BEFORE enqueue: kill-switch off, daily cadence still enqueues nothing', async () => {
    delete process.env.TRACKER_ALERTS_ENABLED; // kill-switch off
    const { svc, digestRows, sendCalls } = makeFanOutService({ owned: true, emailCadence: 'daily' });
    const r = await svc.fanOut(EVENT);
    expect(sendCalls).toEqual([]);
    expect(digestRows).toHaveLength(0);
    expect(r).toEqual({ suppressed: 1, sent: 0, failed: 0, queued: 0 });
  });

  it('5. enqueue is idempotent: a second fanOut for the same event/pref queues nothing new', async () => {
    process.env.TRACKER_ALERTS_ENABLED = 'true';
    const { svc, digestRows } = makeFanOutService({ owned: true, emailCadence: 'daily' });
    const first = await svc.fanOut(EVENT);
    expect(first.queued).toBe(1);
    const second = await svc.fanOut(EVENT);
    expect(second.queued).toBe(0);
    expect(digestRows).toHaveLength(1); // still exactly one queue row
  });
});

describe('IntelAlertService.flushDigests — lifecycle (P0-02, cases 6-12)', () => {
  afterEach(() => {
    delete process.env.TRACKER_ALERTS_ENABLED;
    delete process.env.LEGIWATCH_DIGEST_MAX_ATTEMPTS;
  });

  it('6. one digest contains every eligible alert exactly once', async () => {
    const rows = [
      queueRow({ id: 'q1', alert_id: 'a1' }),
      queueRow({ id: 'q2', alert_id: 'a2' }),
      queueRow({ id: 'q3', alert_id: 'a3' }),
    ];
    const alerts = [
      alertRow({ id: 'a1', evidence: { displayNum: 'H.R. 1', billTitle: 'Act One', stage: 'Amended' } }),
      alertRow({ id: 'a2', evidence: { displayNum: 'H.R. 2', billTitle: 'Act Two', stage: 'Amended' } }),
      alertRow({ id: 'a3', evidence: { displayNum: 'H.R. 3', billTitle: 'Act Three', stage: 'Amended' } }),
    ];
    const { svc, sendCalls } = makeFlushService({
      digestRows: rows,
      alerts,
      prefs: [{ tenantId: 't1', userId: 'u1', clientId: 'c1', emailEnabled: true, emailAddress: 'u1@x.com' }],
      owned: true,
      killSwitchOn: true,
    });
    const r = await svc.flushDigests('daily');
    expect(sendCalls).toHaveLength(1);
    for (const num of ['H.R. 1', 'H.R. 2', 'H.R. 3']) {
      const occurrences = sendCalls[0]!.html.split(num).length - 1;
      expect(occurrences).toBe(1);
    }
    expect(r.sent).toBe(1);
  });

  it('7. a failed digest stays retryable: flushed=false, attempts=1, last_error set, delivered_at null; a second flush re-claims it', async () => {
    const rows = [queueRow({ id: 'q1' })];
    const alerts = [alertRow({})];
    const { svc, store } = makeFlushService({
      digestRows: rows,
      alerts,
      prefs: [{ tenantId: 't1', userId: 'u1', clientId: 'c1', emailEnabled: true, emailAddress: 'u1@x.com' }],
      owned: true,
      killSwitchOn: true,
      sendImpl: async () => ({ sent: false, error: 'smtp 550' }),
    });
    const r = await svc.flushDigests('daily');
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(0);
    const row = store.rows.find((x) => x.id === 'q1')!;
    expect(row.flushed).toBe(false);
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('smtp 550');
    expect(row.delivered_at).toBeNull();

    const second = await svc.flushDigests('daily');
    expect(second.flushed).toBe(1); // re-claimed
    expect(second.failed).toBe(1);
  });

  it('8. dead-letter bound: two failed flushes hit attempts=2 (max=2); a third flush claims nothing', async () => {
    process.env.LEGIWATCH_DIGEST_MAX_ATTEMPTS = '2';
    const rows = [queueRow({ id: 'q1' })];
    const alerts = [alertRow({})];
    const prefs = [{ tenantId: 't1', userId: 'u1', clientId: 'c1', emailEnabled: true, emailAddress: 'u1@x.com' }];
    const failingSend = async () => ({ sent: false, error: 'boom' });

    const first = makeFlushService({ digestRows: rows, alerts, prefs, owned: true, killSwitchOn: true, sendImpl: failingSend });
    const r1 = await first.svc.flushDigests('daily');
    expect(r1.deadLettered).toBe(0);
    expect(first.store.rows[0]!.attempts).toBe(1);

    // Re-run flushDigests against the SAME mutated store to simulate the next sweep.
    const second = makeFlushService({ digestRows: first.store.rows, alerts, prefs, owned: true, killSwitchOn: true, sendImpl: failingSend });
    const r2 = await second.svc.flushDigests('daily');
    expect(r2.deadLettered).toBe(1);
    expect(second.store.rows[0]!.attempts).toBe(2);

    const third = makeFlushService({ digestRows: second.store.rows, alerts, prefs, owned: true, killSwitchOn: true, sendImpl: failingSend });
    const r3 = await third.svc.flushDigests('daily');
    expect(r3.flushed).toBe(0); // attempts(2) >= maxAttempts(2) — never re-claimed
  });

  it('9. rows are marked delivered only after a successful send; the delivered_at UPDATE never runs on failure', async () => {
    const successRows = [queueRow({ id: 'qs' })];
    const successAlerts = [alertRow({})];
    const prefs = [{ tenantId: 't1', userId: 'u1', clientId: 'c1', emailEnabled: true, emailAddress: 'u1@x.com' }];
    const successCase = makeFlushService({ digestRows: successRows, alerts: successAlerts, prefs, owned: true, killSwitchOn: true });
    await successCase.svc.flushDigests('daily');
    expect(successCase.store.rows[0]!.delivered_at).not.toBeNull();

    const failRows = [queueRow({ id: 'qf' })];
    const failAlerts = [alertRow({})];
    const failCase = makeFlushService({
      digestRows: failRows,
      alerts: failAlerts,
      prefs,
      owned: true,
      killSwitchOn: true,
      sendImpl: async () => ({ sent: false, error: 'x' }),
    });
    await failCase.svc.flushDigests('daily');
    expect(failCase.store.rows[0]!.delivered_at).toBeNull();
  });

  it('10. an unresolvable alert_id is counted, never sent for, and stays flushed=true (no throw)', async () => {
    const rows = [queueRow({ id: 'q1', alert_id: 'tracker:c1:119-hr-1:bill_amendment' })];
    const { svc, sendCalls, store } = makeFlushService({
      digestRows: rows,
      alerts: [], // no matching intel_alert row
      prefs: [{ tenantId: 't1', userId: 'u1', clientId: 'c1', emailEnabled: true, emailAddress: 'u1@x.com' }],
      owned: true,
      killSwitchOn: true,
    });
    const r = await svc.flushDigests('daily');
    expect(r.unresolvable).toBe(1);
    expect(sendCalls).toHaveLength(0);
    expect(store.rows[0]!.flushed).toBe(true);
  });

  it('11. grouping: client A before client B, critical before notable within a client', async () => {
    const rows = [
      queueRow({ id: 'q1', alert_id: 'a1-critical', client_id: 'client-a' }),
      queueRow({ id: 'q2', alert_id: 'a1-notable', client_id: 'client-a' }),
      queueRow({ id: 'q3', alert_id: 'a2-critical', client_id: 'client-b' }),
      queueRow({ id: 'q4', alert_id: 'a2-notable', client_id: 'client-b' }),
    ];
    const alerts = [
      alertRow({ id: 'a1-notable', clientId: 'client-a', severity: 'notable', evidence: { displayNum: 'A-NOTABLE' } }),
      alertRow({ id: 'a1-critical', clientId: 'client-a', severity: 'critical', evidence: { displayNum: 'A-CRITICAL' } }),
      alertRow({ id: 'a2-notable', clientId: 'client-b', severity: 'notable', evidence: { displayNum: 'B-NOTABLE' } }),
      alertRow({ id: 'a2-critical', clientId: 'client-b', severity: 'critical', evidence: { displayNum: 'B-CRITICAL' } }),
    ];
    const { svc, sendCalls } = makeFlushService({
      digestRows: rows,
      alerts,
      // Both clients' rows land in ONE (tenant,user,channel) group — flushDigests
      // uses the group's last-seen clientId as the representative pref lookup
      // (documented limitation), so both clients need a pref here regardless
      // of which one ends up representative.
      prefs: [
        { tenantId: 't1', userId: 'u1', clientId: 'client-a', emailEnabled: true, emailAddress: 'u1@x.com' },
        { tenantId: 't1', userId: 'u1', clientId: 'client-b', emailEnabled: true, emailAddress: 'u1@x.com' },
      ],
      owned: true,
      killSwitchOn: true,
      clientNames: new Map([
        ['client-a', 'Acme'],
        ['client-b', 'Beta'],
      ]),
    });
    await svc.flushDigests('daily');
    const html = sendCalls[0]!.html;
    const idxAcme = html.indexOf('Acme');
    const idxBeta = html.indexOf('Beta');
    expect(idxAcme).toBeGreaterThanOrEqual(0);
    expect(idxBeta).toBeGreaterThan(idxAcme); // client A section before client B

    const idxACrit = html.indexOf('A-CRITICAL');
    const idxANotable = html.indexOf('A-NOTABLE');
    expect(idxACrit).toBeGreaterThanOrEqual(0);
    expect(idxANotable).toBeGreaterThan(idxACrit); // critical before notable within client A
  });

  it('12. a not-owned tenant claims the rows but sends nothing and does not reset them', async () => {
    const rows = [queueRow({ id: 'q1' })];
    const { svc, sendCalls, store } = makeFlushService({
      digestRows: rows,
      alerts: [alertRow({})],
      prefs: [{ tenantId: 't1', userId: 'u1', clientId: 'c1', emailEnabled: true, emailAddress: 'u1@x.com' }],
      owned: false,
      killSwitchOn: true,
    });
    const r = await svc.flushDigests('daily');
    expect(r.flushed).toBe(1); // claimed
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(0);
    expect(sendCalls).toHaveLength(0);
    const row = store.rows[0]!;
    expect(row.flushed).toBe(true); // never reset — stays claimed forever until ownership changes
    expect(row.attempts).toBe(0);
  });
});
