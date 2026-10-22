import { harness, freshToken, actor, tenant } from './mailbox-oauth.a1-fixture.js';

jest.mock('@azure/msal-node', () => ({ ConfidentialClientApplication: jest.fn() }));

function pendingRow(provider: 'microsoft_365' | 'google_workspace', id: string) {
  return {
    id,
    tenantId: tenant,
    createdByUserId: actor,
    provider,
    status: 'needs_configuration',
    accountEmail: null,
    token: null,
    syncState: {},
  };
}

describe.each(['microsoft_365', 'google_workspace'] as const)('ML-08 Add reuse %s', (provider) => {
  test('two Connect clicks and one completed flow leave one new mailbox and consume only the latest nonce', async () => {
    const h = harness(provider);
    const established = structuredClone(h.rows.get('connection-A'));
    h.setReturned({ id: 'account-B', email: 'b@example.invalid', refresh: 'refresh-B' });
    const first = await h.start({});
    const second = await h.start({});
    expect(second.connectionId).toBe(first.connectionId);
    expect(h.tx.integrationConnection.create).toHaveBeenCalledTimes(1);
    await expect(h.callback(first.state)).rejects.toThrow('replaced or consumed');
    expect(h.exchange).not.toHaveBeenCalled();
    await h.callback(second.state);
    expect(h.rows.size).toBe(2);
    expect(h.rows.get(second.connectionId).token.homeAccountId).toBe('account-B');
    expect(h.rows.get('connection-A')).toEqual(established);
    expect(h.tx.integrationConnectionToken.upsert).toHaveBeenCalledTimes(1);
  });

  test('chooses the newest fresh actor/provider row and skips unbound rows with prior history', async () => {
    const h = harness(provider);
    const older = pendingRow(provider, 'pending-older');
    const newest = pendingRow(provider, 'pending-newest');
    const history = {
      ...pendingRow(provider, 'pending-history'),
      syncState: { mail: { cursor: 'old' } },
    };
    const otherActor = { ...pendingRow(provider, 'pending-other-actor'), createdByUserId: 'other' };
    const otherTenant = { ...pendingRow(provider, 'pending-other-tenant'), tenantId: 'other' };
    h.rows.set(older.id, older);
    h.rows.set(newest.id, newest);
    h.rows.set(history.id, history);
    h.rows.set(otherActor.id, otherActor);
    h.rows.set(otherTenant.id, otherTenant);
    const before = structuredClone([older, history, otherActor, otherTenant]);
    expect((await h.start({})).connectionId).toBe(newest.id);
    expect(h.tx.integrationConnection.create).not.toHaveBeenCalled();
    expect([older, history, otherActor, otherTenant]).toEqual(before);
  });

  test('skips a no-token row with retained message history without rewriting it', async () => {
    const h = harness(provider);
    const historical = pendingRow(provider, 'pending-with-messages');
    h.rows.set(historical.id, historical);
    h.tx.mailMessage.count.mockResolvedValue(1);
    const before = structuredClone(historical);
    const attempt = await h.start({});
    expect(attempt.connectionId).not.toBe(historical.id);
    expect(h.tx.integrationConnection.create).toHaveBeenCalledTimes(1);
    expect(historical).toEqual(before);
  });

  test('rechecks the candidate under its row lock when a callback establishes an account', async () => {
    const h = harness(provider);
    const candidate = pendingRow(provider, 'pending-raced');
    h.rows.set(candidate.id, candidate);
    const raw = h.tx.$queryRaw.getMockImplementation();
    h.tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join('').includes('FOR UPDATE') && values.includes(candidate.id)) {
        Object.assign(candidate, { token: freshToken('raced-account'), status: 'connected' });
      }
      return raw(sql, ...values);
    });
    const attempt = await h.start({});
    expect(attempt.connectionId).not.toBe(candidate.id);
    expect(candidate).toMatchObject({
      status: 'connected',
      token: { homeAccountId: 'raced-account' },
    });
    expect(
      h.tx.integrationConnection.update.mock.calls.every(
        ([call]: [{ where: { id: string } }]) => call.where.id !== candidate.id,
      ),
    ).toBe(true);
  });

  test('concurrent Add starts serialize the empty lookup and leave one placeholder', async () => {
    const h = harness(provider);
    let lockTail = Promise.resolve();
    h.prisma.withTenant = async (_tenant: string, run: (tx: unknown) => Promise<unknown>) => {
      let unlock: (() => void) | undefined;
      const transaction = {
        ...h.tx,
        $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
          if (
            sql.join('').includes('pg_advisory_xact_lock') &&
            String(values[0]).startsWith('mailbox-add:')
          ) {
            const previous = lockTail;
            lockTail = new Promise<void>((resolve) => {
              unlock = resolve;
            });
            await previous;
            return [];
          }
          return h.tx.$queryRaw(sql, ...values);
        },
      };
      try {
        return await run(transaction);
      } finally {
        unlock?.();
      }
    };
    const [first, second] = await Promise.all([h.start({}), h.start({})]);
    expect(first.connectionId).toBe(second.connectionId);
    expect(h.tx.integrationConnection.create).toHaveBeenCalledTimes(1);
    h.setReturned({ id: 'account-B', email: 'b@example.invalid', refresh: 'refresh-B' });
    await expect(h.callback(first.state)).rejects.toThrow('replaced or consumed');
    await h.callback(second.state);
    expect(h.rows.size).toBe(2);
  });
});
