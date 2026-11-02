import { describe, expect, test } from '@jest/globals';
import { OutreachSendIntentService } from './outreach-send-intent.service.js';

type Row = { id: string; tenantId: string; outreachRecordId: string; v3: boolean };
type Selection = {
  findRunnableIntentId(v3Only: boolean): Promise<string | null>;
  reconcileStale(v3Only: boolean): Promise<void>;
};

// SQL-boundary controls: these execute the actual service methods with a
// synthetic database, not PostgreSQL. The former pre-limit reader is supported
// deliberately so an opposite-owner prefix reproduces its starvation failure.
function harness(rows: Row[]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const tx = {
    outreachSendIntent: { findMany: async ({ take }: { take: number }) => rows.slice(0, take) },
    outreachDelivery: {
      findMany: async ({ take }: { take: number }) => rows.slice(0, take).map(row => ({ id: row.id, sendIntent: row })),
      updateMany: async (args: (typeof updates)[number]) => { updates.push(args); return { count: 1 }; },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      calls.push({ sql, values });
      if (sql.startsWith('SELECT 1 AS found')) {
        return rows.find(row => row.tenantId === values[0] && row.outreachRecordId === values[1])?.v3 ? [{ found: 1 }] : [];
      }
      expect(sql).toContain('AND EXISTS ( SELECT 1 FROM outreach_events AS event');
      expect(sql).toContain('event.tenant_id = intent.tenant_id');
      expect(sql).toContain('event.session_id = intent.outreach_record_id ) = ?');
      expect(sql.indexOf('outreach_events')).toBeLessThan(sql.lastIndexOf('LIMIT'));
      if (sql.startsWith('SELECT intent.id')) {
        expect(values).toHaveLength(1);
        expect(sql).toContain("intent.status IN ('queued', 'running')");
        expect(sql).toContain('delivery.send_intent_id = intent.id');
        expect(sql).toContain('delivery.tenant_id = intent.tenant_id');
        expect(sql).toContain("delivery.status = 'pending'");
        expect(sql).toContain('ORDER BY intent.created_at ASC, intent.id ASC LIMIT 1');
        return rows.filter(row => row.v3 === values[0]).slice(0, 1).map(({ id }) => ({ id }));
      }
      expect(sql).toContain('intent.tenant_id = delivery.tenant_id');
      expect(sql).toContain("WHERE delivery.status = 'sending' AND delivery.claimed_at < ?");
      expect(sql).toContain('ORDER BY delivery.claimed_at ASC, delivery.id ASC LIMIT ?');
      expect(values[0]).toBeInstanceOf(Date);
      expect(values[2]).toBe(500);
      return rows.filter(row => row.v3 === values[1]).slice(0, Number(values[2])).map(({ id }) => ({ id }));
    },
  };
  const subject = Object.create(OutreachSendIntentService.prototype) as Selection;
  Object.assign(subject, { prisma: { withSystem: async (fn: (value: typeof tx) => unknown) => fn(tx) }, staleMs: 1000, logger: { warn() {} } });
  return { subject, calls, updates, tx };
}

function prefix(v3Only: boolean, count: number): Row[] {
  return [
    ...Array.from({ length: count }, (_, i) => ({ id: `opposite-${i}`, tenantId: 'tenant-a', outreachRecordId: `record-${i}`, v3: !v3Only })),
    { id: 'owned', tenantId: 'tenant-b', outreachRecordId: 'owned-record', v3: v3Only },
  ];
}

describe('Outreach worker ownership before population limits', () => {
  test.each([false, true])('selects owned intent behind100 opposite intents (V3=%s)', async v3Only => {
    const h = harness(prefix(v3Only, 100));
    expect(await h.subject.findRunnableIntentId(v3Only)).toBe('owned');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.values).toEqual([v3Only]);
    expect(h.updates).toHaveLength(0);
  });

  test.each([false, true])('ages owned stale claim behind1000 opposite claims (V3=%s)', async v3Only => {
    const h = harness(prefix(v3Only, 1000));
    await h.subject.reconcileStale(v3Only);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.where).toMatchObject({ id: { in: ['owned'] }, status: 'sending' });
    expect(h.updates[0]!.data.status).toBe('unknown');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.values[1]).toBe(v3Only);
  });

  test('preserves finite500 owned stale mutation bound', async () => {
    const h = harness(Array.from({ length: 501 }, (_, i) => ({ id: `owned-${i}`, tenantId: 'tenant', outreachRecordId: `record-${i}`, v3: false })));
    await h.subject.reconcileStale(false);
    expect((h.updates[0]!.where.id as { in: string[] }).in).toHaveLength(500);
    expect(h.updates[0]!.where.claimedAt).toEqual({ lt: h.calls[0]!.values[0] });
    expect(h.updates[0]!.data.status).not.toBe('pending');
  });

  test('empty owned populations neither select nor age another owner', async () => {
    const h = harness(prefix(true, 0));
    expect(await h.subject.findRunnableIntentId(false)).toBeNull();
    await h.subject.reconcileStale(false);
    expect(h.updates).toHaveLength(0);
  });

  test('selection errors propagate without provider or mutation fallback', async () => {
    const h = harness([]);
    h.tx.$queryRaw = async () => { throw new Error('database unavailable'); };
    await expect(h.subject.findRunnableIntentId(false)).rejects.toThrow('database unavailable');
    await expect(h.subject.reconcileStale(false)).rejects.toThrow('database unavailable');
    expect(h.updates).toHaveLength(0);
  });
});
