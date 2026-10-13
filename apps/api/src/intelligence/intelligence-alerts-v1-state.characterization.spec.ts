import {
  clientId,
  clientRow,
  harness,
  installHooks,
  tenantId,
  until,
  userId,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();
type State = 'acknowledged' | 'dismissed' | 'snoozed';

it.each<{ state: State; input: Date | null | undefined; stored: Date | null }>([
  { state: 'acknowledged', input: until, stored: null },
  { state: 'dismissed', input: until, stored: null },
  { state: 'snoozed', input: until, stored: until },
  { state: 'snoozed', input: undefined, stored: null },
])(
  'alert state persists $state with exact tenant/user/client scope and snooze semantics',
  async (example) => {
    const stored = {
      id: 'state-one',
      alertId: 'comment:one',
      state: example.state,
      snoozedUntil: example.stored,
    };
    const h = harness({ results: { stateUpsert: stored } });
    expect(
      await h.service.setAlertState(
        tenantId,
        userId,
        clientId,
        'comment:one',
        example.state,
        example.input,
      ),
    ).toBe(stored);
    expect(h.calls.map((call) => call.operation)).toEqual([
      'withTenant',
      'client',
      'withTenant',
      'stateUpsert',
    ]);
    expect(h.callsOf('client')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      transaction: 1,
      args: [{ where: { id: clientId }, select: { id: true } }],
    });
    expect(h.callsOf('stateUpsert')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      transaction: 2,
      args: [
        {
          where: { userId_clientId_alertId: { userId, clientId, alertId: 'comment:one' } },
          create: {
            tenantId,
            userId,
            clientId,
            alertId: 'comment:one',
            state: example.state,
            snoozedUntil: example.stored,
          },
          update: { state: example.state, snoozedUntil: example.stored },
          select: { id: true, alertId: true, state: true, snoozedUntil: true },
        },
      ],
    });
    expect(h.events.indexOf('tenant:1:commit')).toBeLessThan(h.events.indexOf('tenant:2:begin'));
  },
);

it('alert state refuses a missing tenant client before any second transaction or write', async () => {
  const h = harness({ rows: { client: null } });
  await expect(
    h.service.setAlertState(tenantId, userId, clientId, 'comment:one', 'dismissed'),
  ).rejects.toMatchObject({
    status: 404,
    message: 'Client not found',
  });
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
});

it('alert state preserves archived clients and passes service-level unvalidated enum/user values to I/O', async () => {
  const h = harness({ rows: { client: clientRow({ status: 'archived' }) } });
  await h.service.setAlertState(tenantId, '', clientId, '', 'unknown' as unknown as State, until);
  const call = h.callsOf('stateUpsert')[0]!.args[0] as { create: Record<string, unknown> };
  expect(call.create).toMatchObject({
    userId: '',
    alertId: '',
    state: 'unknown',
    snoozedUntil: null,
  });
});

it('alert state clear is idempotent and scopes deletion without a separate client authorization read', async () => {
  const h = harness({
    rows: { client: null },
    queues: { stateDelete: [{ count: 0 }, { count: 2 }] },
  });
  expect(await h.service.clearAlertState(tenantId, userId, clientId, 'comment:one')).toEqual({
    ok: true,
  });
  expect(await h.service.clearAlertState(tenantId, userId, clientId, 'comment:one')).toEqual({
    ok: true,
  });
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'stateDelete',
    'withTenant',
    'stateDelete',
  ]);
  expect(h.callsOf('stateDelete')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    args: [{ where: { userId, clientId, alertId: 'comment:one' } }],
  });
});

it.each(['client', 'stateUpsert'])(
  'alert state set propagates %s errors without swallowing write/auth failures',
  async (operation) => {
    const failure = new Error(`failed:${operation}`);
    const h = harness({ errors: { [operation]: failure } });
    await expect(
      h.service.setAlertState(tenantId, userId, clientId, 'comment:one', 'acknowledged'),
    ).rejects.toBe(failure);
    expect(h.warnings).toEqual([]);
    if (operation === 'client') expect(h.callsOf('stateUpsert')).toEqual([]);
  },
);

it('alert state clear propagates delete failure rather than reporting success', async () => {
  const failure = new Error('delete failed');
  const h = harness({ errors: { stateDelete: failure } });
  await expect(h.service.clearAlertState(tenantId, userId, clientId, 'comment:one')).rejects.toBe(
    failure,
  );
  expect(h.events).toContain('tenant:1:rollback');
});
