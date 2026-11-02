import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TrackerEmailService } from './tracker-email.service.js';
import type { SmsService } from '../sms/sms.service.js';
import { TrackerAlertService } from './tracker-alert.service.js';
import type { TrackerAlertEvent } from './tracker-notification.types.js';

const event: TrackerAlertEvent = {
  tenantId: 'tenant-a',
  clientId: 'client-a',
  billId: 'bill-a',
  displayNum: 'HB 1',
  billTitle: 'Synthetic bill',
  changeType: 'hearing',
  triggerKey: 'hearing',
  label: 'Hearing',
  tone: 'info',
  severity: 'notable',
  detail: 'Synthetic',
  actionDate: null,
  url: '',
};
const preference = {
  userId: 'user-a',
  clientId: 'client-a',
  triggers: ['hearing'],
  materiality: 'low',
  emailEnabled: true,
  emailAddress: 'recipient@example.test',
  emailCadence: 'daily',
  smsEnabled: false,
};
type Row = Record<string, any>;

/** Stateful transaction double: commits claims/queue together and rolls back failures. No provider is invoked inside it. */
function fixture() {
  let logs: Row[] = [];
  let queue: Row[] = [];
  let lock = Promise.resolve();
  let transactionOpen = false;
  let failReceipt = false;
  let failConsume = false;
  const prefs: Row[] = [{ ...preference }];
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === 'object' ? value.in.includes(row[key]) : row[key] === value,
    );
  const tx = {
    alertPreference: {
      findMany: jest.fn(async ({ where }: Row) => prefs.filter((p) => matches(p, where))),
      findFirst: jest.fn(async ({ where }: Row) => prefs.find((p) => matches(p, where)) ?? null),
    },
    notificationLog: {
      create: jest.fn(async ({ data }: Row) => {
        if (logs.some((r) => ['alertId', 'userId', 'channel'].every((key) => r[key] === data[key])))
          throw { code: 'P2002' };
        const row = { ...data, id: `log-${logs.length}` };
        logs.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        if (failReceipt) throw new Error('receipt unavailable');
        Object.assign(
          logs.find((r) => r.id === where.id)!,
          data,
        );
      }),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        if (where.status === 'outcome_unknown' && failReceipt)
          throw new Error('receipt unavailable');
        const selected = logs.filter((r) => matches(r, where));
        selected.forEach((r) => Object.assign(r, data));
        return { count: selected.length };
      }),
    },
    alertDigestQueue: {
      create: jest.fn(async ({ data }: Row) => {
        const row = { ...data, id: `queue-${queue.length}`, flushed: false };
        queue.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: Row) =>
        queue.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        if (failConsume) throw new Error('queue unavailable');
        const selected = queue.filter((r) => matches(r, where));
        selected.forEach((r) => Object.assign(r, data));
        return { count: selected.length };
      }),
    },
  };
  const transaction = async (fn: (value: typeof tx) => Promise<unknown>) => {
    const previous = lock;
    let release!: () => void;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = structuredClone({ logs, queue });
    transactionOpen = true;
    try {
      return await fn(tx);
    } catch (cause) {
      logs = before.logs;
      queue = before.queue;
      throw cause;
    } finally {
      transactionOpen = false;
      release();
    }
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (value: typeof tx) => Promise<unknown>) =>
      transaction(fn),
    ),
    withSystem: jest.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const email = {
    send: jest.fn(async (_to: string, _subject: string, _html: string, _text: string) => {
      expect(transactionOpen).toBe(false);
      expect(logs.some((row) => row.status === 'outcome_unknown')).toBe(true);
      return { status: 'accepted', messageId: 'receipt' };
    }),
  };
  const settings: Record<string, unknown> = {
    TRACKER_ALERTS_ENABLED: true,
    // Core's protected-retrieval transport and the browser origin are separate owners.
    TRACKER_APP_BASE_URL: 'https://first-chat-preview.app-dev.capiro.ai',
    LEGIWATCH_APP_BASE_URL: 'https://app.capiro.ai',
  };
  const config = {
    get: (key: string) => settings[key],
    set: (key: string, value: unknown) => {
      settings[key] = value;
    },
  } as unknown as ConfigService<AppConfig, true>;
  const service = new TrackerAlertService(
    prisma,
    email as unknown as TrackerEmailService,
    { send: jest.fn() } as unknown as SmsService,
    config,
  );
  return {
    service,
    email,
    prefs,
    config,
    tx,
    logs: () => logs,
    queue: () => queue,
    failReceipt: () => {
      failReceipt = true;
    },
    failConsume: () => {
      failConsume = true;
    },
  };
}

describe('Tracker durable delivery claims', () => {
  it('links the browser to the app origin instead of the Core transport host', async () => {
    const f = fixture();
    f.prefs[0]!.emailCadence = 'realtime';
    await f.service.fanOut(event);
    const [, , html, text] = f.email.send.mock.calls[0]!;
    const board = `https://app.capiro.ai/legiwatch?tab=feed&client=${encodeURIComponent(event.clientId)}`;
    // The HTML anchor escapes the query separator; the plain-text alternative keeps it raw.
    expect(html).toContain(board.replace('&', '&amp;'));
    expect(text).toContain(board);
    // The retrieval transport stays on the preview Core host and must not leak into a link.
    expect(`${html}${text}`).not.toContain('first-chat-preview.app-dev.capiro.ai');
    expect(f.config.get('TRACKER_APP_BASE_URL')).toBe(
      'https://first-chat-preview.app-dev.capiro.ai',
    );
  });

  it('allows only one concurrent realtime dispatch for the same unique claim', async () => {
    const f = fixture();
    f.prefs[0]!.emailCadence = 'realtime';
    await Promise.all([f.service.fanOut(event), f.service.fanOut(event)]);
    expect(f.email.send).toHaveBeenCalledTimes(1);
    expect(f.logs()).toMatchObject([{ status: 'accepted', providerMessageId: 'receipt' }]);
  });

  it('keeps realtime acceptance unknown after a receipt-write failure and never retries', async () => {
    const f = fixture();
    f.prefs[0]!.emailCadence = 'realtime';
    f.failReceipt();
    await expect(f.service.fanOut(event)).rejects.toThrow('receipt unavailable');
    await f.service.fanOut(event);
    expect(f.logs()[0]!.status).toBe('outcome_unknown');
    expect(f.email.send).toHaveBeenCalledTimes(1);
  });

  it.each(['accepted', 'failed', 'outcome_unknown'])(
    'consumes digest before dispatch and records %s without replay',
    async (status) => {
      const f = fixture();
      await f.service.fanOut(event);
      f.email.send.mockImplementation(async () => {
        expect(f.queue().every((r) => r.flushed)).toBe(true);
        expect(f.logs()[0]!.status).toBe('outcome_unknown');
        return { status, messageId: status === 'accepted' ? 'receipt' : '' };
      });
      const first = await f.service.flushDigests('daily');
      expect(first[status as 'accepted']).toBe(1);
      expect(f.logs()[0]!.status).toBe(status);
      expect(await f.service.flushDigests('daily')).toMatchObject({ flushed: 0, accepted: 0 });
      expect(f.email.send).toHaveBeenCalledTimes(1);
    },
  );

  it('allows only one concurrent digest dispatch', async () => {
    const f = fixture();
    await f.service.fanOut(event);
    const results = await Promise.all([
      f.service.flushDigests('daily'),
      f.service.flushDigests('daily'),
    ]);
    expect(f.email.send).toHaveBeenCalledTimes(1);
    expect(results.reduce((n, result) => n + result.flushed, 0)).toBe(1);
  });

  it('does not send when consuming the queue fails; its claim rolls back', async () => {
    const f = fixture();
    await f.service.fanOut(event);
    f.failConsume();
    await expect(f.service.flushDigests('daily')).rejects.toThrow('queue unavailable');
    expect(f.logs()[0]!.status).toBe('queued');
    expect(f.queue()[0]!.flushed).toBe(false);
    expect(f.email.send).not.toHaveBeenCalled();
  });

  it('retains unknown after SES acceptance and a digest receipt-write failure', async () => {
    const f = fixture();
    await f.service.fanOut(event);
    f.failReceipt();
    await expect(f.service.flushDigests('daily')).rejects.toThrow('receipt unavailable');
    expect(f.logs()[0]!.status).toBe('outcome_unknown');
    expect(f.queue()[0]!.flushed).toBe(true);
    await f.service.flushDigests('daily');
    expect(f.email.send).toHaveBeenCalledTimes(1);
  });

  it('never reclaims an unknown/crashed or historical sending digest claim', async () => {
    for (const status of ['outcome_unknown', 'sending']) {
      const f = fixture();
      await f.service.fanOut(event);
      f.logs()[0]!.status = status;
      await f.service.flushDigests('daily');
      expect(f.email.send).not.toHaveBeenCalled();
      expect(f.logs()[0]!.status).toBe(status);
    }
  });

  it('honors disabled alerts and current per-client preferences without mixing client batches', async () => {
    const f = fixture();
    await f.service.fanOut(event);
    f.prefs.push({ ...preference, clientId: 'client-b' });
    await f.service.fanOut({ ...event, clientId: 'client-b' });
    f.prefs[0]!.emailEnabled = false;
    f.config.set('TRACKER_ALERTS_ENABLED', false);
    await f.service.flushDigests('daily');
    expect(f.email.send).not.toHaveBeenCalled();
    f.config.set('TRACKER_ALERTS_ENABLED', true);
    await f.service.flushDigests('daily');
    expect(f.logs().map((r) => r.status)).toEqual(['suppressed', 'accepted']);
    expect(f.email.send).toHaveBeenCalledTimes(1);
  });

  it.each(['removed', 'changed-cadence'])(
    'suppresses a queued email when its current preference is %s',
    async (change) => {
      const f = fixture();
      await f.service.fanOut(event);
      if (change === 'removed') f.prefs.length = 0;
      else f.prefs[0]!.emailCadence = 'weekly';
      expect(await f.service.flushDigests('daily')).toMatchObject({ suppressed: 1, accepted: 0 });
      expect(f.email.send).not.toHaveBeenCalled();
      expect(f.logs()[0]!.status).toBe('suppressed');
    },
  );
});
