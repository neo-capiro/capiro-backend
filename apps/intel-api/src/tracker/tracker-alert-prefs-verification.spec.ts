import { TrackerWatchlistService } from './tracker-watchlist.service.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

const TENANT = 'tenant-a';
const CLIENT = '11111111-1111-1111-1111-111111111111';
const PHONE = '+14155551234';

describe('Tracker alert preferences retain verification only for the verified number', () => {
  function setup(smsPhoneVerified = true) {
    let row: Record<string, unknown> = { tenantId: TENANT, smsPhone: PHONE, smsPhoneVerified };
    const tx = {
      $queryRaw: jest.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => [{ smsPhone: row.smsPhone, smsPhoneVerified: row.smsPhoneVerified }]),
      intelAlertPreference: {
        findUnique: jest.fn(async () => row),
        upsert: jest.fn(async ({ update }: { update: Record<string, unknown> }) => {
          row = { ...row, ...update };
          return row;
        }),
      },
    };
    const prisma = {
      withSystem: async (run: (db: unknown) => unknown) => run({ $queryRawUnsafe: async () => [{ id: CLIENT }] }),
      withTenant: async (_tenant: string, run: (db: typeof tx) => unknown) => run(tx),
    };
    return { service: new TrackerWatchlistService(prisma as never), tx };
  }

  it('clears verification when saving a different phone', async () => {
    const { service, tx } = setup();
    const result = await service.putAlertPrefs(TENANT, CLIENT, 'user-a', { smsPhone: '+14155556789', smsEnabled: true });
    expect(result.smsPhone).toBe('+14155556789');
    expect(result.smsPhoneVerified).toBe(false);
    const [sql, ...values] = tx.$queryRaw.mock.calls[0]!;
    expect((sql as TemplateStringsArray).join('?')).toContain('FOR UPDATE');
    expect(values).toEqual([TENANT, CLIENT, 'user-a']);
  });

  it('preserves verification when only the phone formatting changes', async () => {
    const { service } = setup();
    const result = await service.putAlertPrefs(TENANT, CLIENT, 'user-a', { smsPhone: '(415) 555-1234' });
    expect(result.smsPhone).toBe(PHONE);
    expect(result.smsPhoneVerified).toBe(true);
  });

  it.each([null, undefined, 'invalid'])('clears verification when the saved number is removed or invalid (%s)', async (smsPhone) => {
    const { service } = setup();
    const result = await service.putAlertPrefs(TENANT, CLIENT, 'user-a', { smsPhone });
    expect(result.smsPhone).toBeNull();
    expect(result.smsPhoneVerified).toBe(false);
  });

  it('never verifies an unverified number by saving preferences', async () => {
    const { service } = setup(false);
    const result = await service.putAlertPrefs(TENANT, CLIENT, 'user-a', { smsPhone: PHONE });
    expect(result.smsPhoneVerified).toBe(false);
  });
});
