import {
  harness,
  clientId,
  tenantId,
  userId,
  now,
  billRow,
  trackedRow,
  installHooks,
} from '../../test/fixtures/intelligence-bills.js';

installHooks();
const sql = (args: unknown[]) =>
  (args[0] as TemplateStringsArray).join('$1').replace(/\s+/g, ' ').trim();

describe('Manual tracked-bill listing preserves tenant rows and joins', () => {
  it('returns tenant-created order and null for missing global bill hydration', async () => {
    const tracked = [
      trackedRow({ id: 'pin-new', billId: 'new', note: 'New note', createdAt: now }),
      trackedRow({ id: 'pin-missing', billId: 'missing', note: null }),
      trackedRow({ id: 'pin-old', billId: 'old', note: 'Old note' }),
    ];
    const h = harness({
      rows: { trackedBills: tracked, billRows: [billRow({ id: 'old' }), billRow({ id: 'new' })] },
    });
    const out = await h.service.listTrackedBills(clientId, tenantId);
    expect(
      out.map(({ id, billId, note, bill }) => ({
        id,
        billId,
        note,
        hydrated: bill?.identifier ?? null,
      })),
    ).toEqual([
      { id: 'pin-new', billId: 'new', note: 'New note', hydrated: 'new' },
      { id: 'pin-missing', billId: 'missing', note: null, hydrated: null },
      { id: 'pin-old', billId: 'old', note: 'Old note', hydrated: 'old' },
    ]);
    expect(out[0]!.createdAt).toBe(now);
    expect(h.callsOf('trackedBills')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      args: [{ where: { clientId }, orderBy: { createdAt: 'desc' } }],
    });
    expect(h.callsOf('billRows')[0]!.args.slice(1)).toEqual([['new', 'missing', 'old']]);
  });
  it('does not fetch globally when the scoped tracking ledger is empty', async () => {
    const h = harness();
    expect(await h.service.listTrackedBills(clientId, tenantId)).toEqual([]);
    expect(h.callsOf('billRows')).toEqual([]);
  });
  it('propagates both scoped-list and global-hydration failures', async () => {
    const h = harness({ errors: { trackedBills: new Error('tracked read failed') } });
    await expect(h.service.listTrackedBills(clientId, tenantId)).rejects.toThrow(
      'tracked read failed',
    );
    const hydrate = harness({
      rows: { trackedBills: [trackedRow()] },
      errors: { billRows: new Error('bill hydration failed') },
    });
    await expect(hydrate.service.listTrackedBills(clientId, tenantId)).rejects.toThrow(
      'bill hydration failed',
    );
  });
});

describe('Manual pin validation preserves its exact failure order', () => {
  it('rejects blank IDs before global existence or tenant access reads', async () => {
    const h = harness();
    await expect(h.service.addTrackedBill(clientId, tenantId, ' \t ')).rejects.toThrow(
      'billId is required',
    );
    expect(h.calls).toEqual([]);
  });
  it('rejects a missing global bill before reading the scoped client', async () => {
    const h = harness({ rows: { billExists: [] } });
    await expect(h.service.addTrackedBill(clientId, tenantId, ' Missing-Bill ')).rejects.toThrow(
      'Bill Missing-Bill not found',
    );
    expect(h.calls.map((call) => call.operation)).toEqual(['billExists']);
    expect(h.callsOf('billExists')[0]!.args.slice(1)).toEqual(['Missing-Bill']);
  });
  it('rejects an inaccessible client only after global bill verification and before upsert', async () => {
    const h = harness({ rows: { billExists: [{ id: '119-hr-1' }] }, results: { client: null } });
    await expect(h.service.addTrackedBill(clientId, tenantId, '119-hr-1')).rejects.toThrow(
      `Client ${clientId} not found`,
    );
    expect(h.calls.map((call) => call.operation)).toEqual(['billExists', 'withTenant', 'client']);
    expect(h.callsOf('client')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      args: [{ where: { id: clientId }, select: { id: true } }],
    });
  });
  it.each(['billExists', 'client', 'upsert'])(
    'propagates %s I/O failure without later writes',
    async (operation) => {
      const h = harness({
        rows: { billExists: [{ id: '119-hr-1' }] },
        errors: { [operation]: new Error(`${operation} unavailable`) },
      });
      await expect(h.service.addTrackedBill(clientId, tenantId, '119-hr-1')).rejects.toThrow(
        `${operation} unavailable`,
      );
      expect(h.calls.map((call) => call.operation)).toEqual(
        operation === 'billExists'
          ? ['billExists']
          : operation === 'client'
            ? ['billExists', 'withTenant', 'client']
            : ['billExists', 'withTenant', 'client', 'withTenant', 'upsert'],
      );
    },
  );
});

describe('Manual upsert note, actor and idempotency contracts', () => {
  it.each([
    {
      note: undefined,
      actor: undefined,
      updatedNote: undefined,
      storedNote: null,
      storedActor: null,
    },
    { note: null, actor: null, updatedNote: undefined, storedNote: null, storedActor: null },
    { note: '', actor: '', updatedNote: '', storedNote: '', storedActor: '' },
    {
      note: '  Rationale  ',
      actor: userId,
      updatedNote: '  Rationale  ',
      storedNote: '  Rationale  ',
      storedActor: userId,
    },
  ])(
    'preserves untrimmed/null/omitted note and createdBy semantics: %p',
    async ({ note, actor, updatedNote, storedNote, storedActor }) => {
      const h = harness({ rows: { billExists: [{ id: '119-hr-1' }] } });
      await h.service.addTrackedBill(
        clientId,
        tenantId,
        ' 119-hr-1 ',
        note as unknown as string | undefined,
        actor as unknown as string | undefined,
      );
      expect(sql(h.callsOf('billExists')[0]!.args)).toBe(
        'SELECT id FROM congress_bill WHERE id = $1 LIMIT 1',
      );
      expect(h.callsOf('billExists')[0]).toMatchObject({ scope: 'global' });
      expect(h.callsOf('upsert')[0]).toMatchObject({
        scope: 'tenant',
        tenantId,
        args: [
          {
            where: { clientId_billId: { clientId, billId: '119-hr-1' } },
            update: { note: updatedNote },
            create: {
              tenantId,
              clientId,
              billId: '119-hr-1',
              note: storedNote,
              createdBy: storedActor,
            },
          },
        ],
      });
      expect(h.calls.map((call) => call.operation)).toEqual([
        'billExists',
        'withTenant',
        'client',
        'withTenant',
        'upsert',
      ]);
    },
  );
  it('uses the same unique pin key for repeats and updates only note while returning the ORM row unchanged', async () => {
    const row = trackedRow({ id: 'existing-pin', billId: '119-hr-1', createdBy: 'original-actor' });
    const h = harness({ rows: { billExists: [{ id: '119-hr-1' }] }, results: { upsert: row } });
    expect(await h.service.addTrackedBill(clientId, tenantId, '119-hr-1', 'first', userId)).toBe(
      row,
    );
    expect(
      await h.service.addTrackedBill(clientId, tenantId, ' 119-hr-1 ', 'second', 'another-actor'),
    ).toBe(row);
    const requests = h
      .callsOf('upsert')
      .map((call) => call.args[0] as { where: unknown; update: unknown });
    expect(requests.map((input) => input.where)).toEqual([
      { clientId_billId: { clientId, billId: '119-hr-1' } },
      { clientId_billId: { clientId, billId: '119-hr-1' } },
    ]);
    expect(requests.map((input) => input.update)).toEqual([{ note: 'first' }, { note: 'second' }]);
    expect(row.createdBy).toBe('original-actor');
  });
});

describe('Manual removal remains scoped and idempotent', () => {
  it('returns removed true for a missing pin using the trimmed client/bill predicate only', async () => {
    const h = harness({ results: { delete: { count: 0 } } });
    expect(await h.service.removeTrackedBill(clientId, tenantId, ' 119-hr-1 ')).toEqual({
      removed: true,
    });
    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'delete']);
    expect(h.callsOf('delete')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      args: [{ where: { clientId, billId: '119-hr-1' } }],
    });
  });
  it('retains blank-removal behavior rather than adding pin-creation validation', async () => {
    const h = harness();
    expect(await h.service.removeTrackedBill(clientId, tenantId, ' \t ')).toEqual({
      removed: true,
    });
    expect(h.callsOf('delete')[0]!.args).toEqual([{ where: { clientId, billId: '' } }]);
  });
  it('propagates removal failure without falsely reporting a successful deletion', async () => {
    const h = harness({ errors: { delete: new Error('delete failed') } });
    await expect(h.service.removeTrackedBill(clientId, tenantId, '119-hr-1')).rejects.toThrow(
      'delete failed',
    );
  });
});
