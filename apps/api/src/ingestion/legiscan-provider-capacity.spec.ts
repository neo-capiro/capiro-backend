import { getSessionList } from '../external/legiscan/legiscan.client.js';
import {
  capacityIdentity,
  LegiscanProviderCapacityError,
} from '../external/legiscan/legiscan-capacity.js';
import {
  withLegiscanApiAllowed,
  recordLegiscanCapacityHold,
  releaseLegiscanCapacityHold,
} from './legiscan-provider-capacity.js';
import { parseCapacityArgs } from '../../scripts/record-legiscan-capacity-hold.js';
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});
function db(held = false) {
  return {
    $queryRawUnsafe: jest.fn(async () => (held ? [{ cursor: { exhausted: true } }] : [])),
    $executeRawUnsafe: jest.fn(async () => 1),
  } as any;
}
test('actual monthly error persists one hold and blocks later operations with no retry or second fetch', async () => {
  const database = db(),
    key = 'synthetic-capacity-response';
  global.fetch = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'ERROR',
          alert: {
            message:
              'API key has exceeded maximum query count for November 2026 (10,095 of 10,000); limit resets December 1st',
          },
        }),
        { status: 200 },
      ),
  );
  await expect(
    withLegiscanApiAllowed(database, key, () => getSessionList(key, 'FL')),
  ).rejects.toMatchObject({ requestAttempts: 1, reportedUsed: 10095, reportedLimit: 10000 });
  await expect(
    withLegiscanApiAllowed(database, key, () => getSessionList(key, 'CA')),
  ).rejects.toBeInstanceOf(LegiscanProviderCapacityError);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(database.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  expect(database.$executeRawUnsafe.mock.calls[0][2]).toContain('"exhausted":true');
});
test('a fresh process/key reads the durable hold before reserving or calling any provider', async () => {
  const run = jest.fn(),
    database = db(true);
  global.fetch = jest.fn();
  await expect(withLegiscanApiAllowed(database, 'synthetic-durable-hold', run)).rejects.toThrow(
    'MONTHLY_CAPACITY_HOLD',
  );
  expect(run).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});
test('key/month changes select a different internal hold without logging either identifier', () => {
  const first = capacityIdentity('synthetic-one', new Date('2026-11-02Z'));
  expect(capacityIdentity('synthetic-two', new Date('2026-11-02Z')).source).not.toBe(first.source);
  expect(capacityIdentity('synthetic-one', new Date('2026-12-02Z')).source).not.toBe(first.source);
  expect(new LegiscanProviderCapacityError('2026-11').message).toBe(
    'LEGISCAN_PROVIDER_MONTHLY_CAPACITY_HOLD',
  );
});
test('a hold committed by another worker is reread before a transport retry', async () => {
  const database = db(),
    key = 'synthetic-concurrent-hold';
  database.$queryRawUnsafe
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ cursor: { exhausted: true } }]);
  global.fetch = jest.fn(
    async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }),
  );
  await expect(
    withLegiscanApiAllowed(database, key, () =>
      getSessionList(key, 'FL', { maxAttempts: 2, timeoutMs: 1000 }),
    ),
  ).rejects.toMatchObject({ requestAttempts: 1 });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(database.$queryRawUnsafe).toHaveBeenCalledTimes(3);
});
test('hold database failures fail closed with fixed scrubbed messages', async () => {
  const database = db();
  database.$queryRawUnsafe.mockRejectedValue(Error('private query arguments'));
  const run = jest.fn();
  await expect(withLegiscanApiAllowed(database, 'synthetic-read-failure', run)).rejects.toThrow(
    'LEGISCAN_CAPACITY_HOLD_READ_FAILED',
  );
  expect(run).not.toHaveBeenCalled();
  database.$executeRawUnsafe.mockRejectedValue(Error('private query arguments'));
  await expect(
    recordLegiscanCapacityHold(database, 'synthetic-persist', {
      month: new Date().toISOString().slice(0, 7),
    }),
  ).rejects.toThrow('LEGISCAN_CAPACITY_HOLD_PERSIST_FAILED');
});
test('recovery is an explicit current-month account-change attestation and no provider probe', async () => {
  const base = [
    '--month',
    new Date().toISOString().slice(0, 7),
    '--observed-used',
    '10095',
    '--observed-limit',
    '10000',
  ];
  expect(parseCapacityArgs(base, {}).commit).toBe(false);
  expect(() => parseCapacityArgs([...base, '--release'], {})).toThrow('INVALID_CAPACITY');
  expect(() => parseCapacityArgs([...base, '--commit'], {})).toThrow('CONFIGURATION');
  const recovery = [...base];
  recovery[3] = '500';
  recovery.push('--release', '--confirmed-account-change');
  expect(parseCapacityArgs(recovery, {}).release).toBe(true);
  const database = db();
  global.fetch = jest.fn();
  await releaseLegiscanCapacityHold(database, 'synthetic-operator-release');
  expect(global.fetch).not.toHaveBeenCalled();
  expect(database.$executeRawUnsafe.mock.calls[0][0]).toContain("'exhausted',false");
});
