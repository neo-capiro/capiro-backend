import { harness, installHooks, args } from './fixtures/tracker-board-ownership/harness.js';
import {
  billId,
  stateId,
  clientId,
  tenantId,
  userId,
  now,
  federal,
  state,
  tracked,
  deferred,
} from './fixtures/tracker-board-ownership/rows.js';

installHooks();

it('awaits real system ownership and source identity before upsert, then keeps tracked feedback a separate best-effort commit', async () => {
  const guard = deferred<Array<{ id: string }>>(),
    identity = deferred<ReturnType<typeof federal>[]>();
  const returned = tracked();
  const h = harness({
    results: {
      clientOwnership: guard.promise,
      federalIdentity: identity.promise,
      'trackedBill.upsert': returned,
      'intelFeedback.create': new Error('learning unavailable'),
    },
  });
  const pending = h.service.trackBill(tenantId, clientId, userId, billId, {
    note: 'note',
    isManual: true,
  });
  await h.started('clientOwnership');
  expect(h.callsOf('clientOwnership')[0]!.args.slice(1)).toEqual([clientId, tenantId]);
  expect(h.callsOf('clientOwnership')[0]!.scope).toBe('system');
  expect(h.callsOf('federalIdentity')).toHaveLength(0);
  guard.resolve([{ id: clientId }]);
  await h.started('federalIdentity');
  expect(h.callsOf('trackedBill.upsert')).toHaveLength(0);
  identity.resolve([federal()]);
  expect(await pending).toBe(returned);
  const write = h.callsOf('trackedBill.upsert')[0]!,
    feedback = h.callsOf('intelFeedback.create')[0]!;
  expect(args(write)).toEqual({
    where: { clientId_billId: { clientId, billId } },
    create: {
      tenantId,
      clientId,
      billId,
      source: 'congress',
      note: 'note',
      isManual: true,
      trackedBy: userId,
      stage: 'committee',
      lastSeenActionText: 'Referred to committee',
      lastSeenActionDate: federal().latestActionDate,
      lastSeenAt: now,
    },
    update: { note: 'note' },
  });
  expect(args(feedback)).toEqual({
    data: { tenantId, clientId, userId, targetType: 'bill', targetRef: billId, signal: 'tracked' },
  });
  expect(write.transaction).not.toBe(feedback.transaction);
  expect(h.events.indexOf(`tx:end:${write.transaction}`)).toBeLessThan(
    h.events.indexOf('intelFeedback.create'),
  );
});

it.each([
  { id: stateId, source: undefined },
  { id: billId, source: 'state' },
])(
  'routes tracking through state identity for %j before its scoped write',
  async ({ id, source }) => {
    const h = harness({ results: { stateRows: [state({ id, status: 'vetoed' })] } });
    await h.service.trackBill(tenantId, clientId, userId, id, { source, note: null });
    expect(h.callsOf('federalIdentity')).toHaveLength(0);
    expect(h.callsOf('stateRows')[0]!.args[1]).toEqual([id]);
    expect(args(h.callsOf('trackedBill.upsert')[0]!).create).toMatchObject({
      source: 'state',
      stage: 'passed',
    });
    expect(args(h.callsOf('trackedBill.upsert')[0]!).update).toEqual({ note: null });
  },
);

it('does not clear existing fields on idempotent tracking without a supplied note', async () => {
  const h = harness({ results: { federalIdentity: [federal()] } });
  await h.service.trackBill(tenantId, clientId, userId, billId, { source: 'recommended' });
  expect(args(h.callsOf('trackedBill.upsert')[0]!).update).toEqual({});
  expect(args(h.callsOf('trackedBill.upsert')[0]!).create).toMatchObject({
    source: 'recommended',
    isManual: false,
    note: null,
  });
});

it.each(['federalIdentity', 'trackedBill.upsert'])(
  'keeps %s failure fatal and never writes tracked feedback',
  async (operation) => {
    const failure = new Error(operation);
    const h = harness({ results: { federalIdentity: [federal()], [operation]: failure } });
    await expect(h.service.trackBill(tenantId, clientId, userId, billId)).rejects.toBe(failure);
    expect(h.callsOf('intelFeedback.create')).toHaveLength(0);
  },
);

it('rejects absent source identity after ownership without performing either write', async () => {
  const h = harness();
  await expect(h.service.trackBill(tenantId, clientId, userId, billId)).rejects.toThrow(
    `Bill ${billId} not found`,
  );
  expect(h.callsOf('clientOwnership')).toHaveLength(1);
  expect(h.callsOf('trackedBill.upsert')).toHaveLength(0);
  expect(h.callsOf('intelFeedback.create')).toHaveLength(0);
});

it('returns the scoped delete count without suppressing future recommendation feedback', async () => {
  const h = harness({ results: { 'trackedBill.deleteMany': { count: 3 } } });
  expect(await h.service.untrackBill(tenantId, clientId, billId)).toEqual({ ok: true, removed: 3 });
  expect(args(h.callsOf('trackedBill.deleteMany')[0]!)).toEqual({
    where: { tenantId, clientId, billId },
  });
  expect(h.events.indexOf('clientOwnership')).toBeLessThan(
    h.events.indexOf('trackedBill.deleteMany'),
  );
  expect(h.callsOf('intelFeedback.create')).toHaveLength(0);
});

it('updates only explicit context fields and performs a separate scoped reread after commit', async () => {
  const returned = tracked({ note: 'legacy note' });
  const h = harness({ results: { 'trackedBill.findFirst': returned } });
  expect(
    await h.service.updateBillContext(tenantId, clientId, userId, billId, {
      position: 'oppose',
      analystNote: '',
      expectedWindowStart: '',
      expectedConfidence: 'low',
    }),
  ).toEqual({ ok: true, bill: returned });
  const update = h.callsOf('trackedBill.updateMany')[0]!,
    read = h.callsOf('trackedBill.findFirst')[0]!;
  expect(args(update)).toEqual({
    where: { tenantId, clientId, billId },
    data: {
      position: 'oppose',
      analystNote: '',
      expectedWindowStart: null,
      expectedConfidence: 'low',
      expectedUpdatedBy: userId,
      expectedUpdatedAt: now,
    },
  });
  expect(args(read)).toEqual({ where: { tenantId, clientId, billId } });
  expect(update.transaction).not.toBe(read.transaction);
  expect(h.events.indexOf(`tx:end:${update.transaction}`)).toBeLessThan(
    h.events.indexOf('trackedBill.findFirst'),
  );
  expect(h.callsOf('clientOwnership')).toHaveLength(0);
});

it('leaves expected attribution untouched for a plain partial context change', async () => {
  const h = harness();
  await h.service.updateBillContext(tenantId, clientId, userId, billId, { priority: 'high' });
  expect(args(h.callsOf('trackedBill.updateMany')[0]!).data).toEqual({ priority: 'high' });
});

it('rejects reversed expected windows before any I/O and preserves the original validation precedence', async () => {
  const h = harness({ results: { 'trackedBill.updateMany': { count: 0 } } });
  await expect(
    h.service.updateBillContext(tenantId, clientId, userId, billId, {
      expectedWindowStart: '2026-12-02',
      expectedWindowEnd: '2026-12-01',
    }),
  ).rejects.toThrow('EXPECTED_WINDOW_END_BEFORE_START');
  expect(h.calls).toEqual([]);
});

it('returns not-tracked404 after a zero-count context update without rereading', async () => {
  const h = harness({ results: { 'trackedBill.updateMany': { count: 0 } } });
  await expect(h.service.updateBillContext(tenantId, clientId, userId, billId, {})).rejects.toThrow(
    'CLIENT_BILL_NOT_TRACKED',
  );
  expect(h.callsOf('trackedBill.findFirst')).toHaveLength(0);
});

it('keeps the committed context update when its independent reread fails', async () => {
  const failure = new Error('read unavailable');
  const h = harness({ results: { 'trackedBill.findFirst': failure } });
  await expect(
    h.service.updateBillContext(tenantId, clientId, userId, billId, { analystNote: 'saved' }),
  ).rejects.toBe(failure);
  const write = h.callsOf('trackedBill.updateMany')[0]!;
  expect(h.events).toContain(`tx:end:${write.transaction}`);
  expect(h.callsOf('trackedBill.updateMany')).toHaveLength(1);
});
