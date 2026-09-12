import { SmsVerificationService } from '../src/tracker/sms/sms-verification.service.js';
import { SmsService, maskPhone, normalizeE164, smsSize } from '../src/tracker/sms/sms.service.js';
import {
  TrackerWatchlistService,
  DEFAULT_TRIGGERS,
} from '../src/tracker/tracker-watchlist.service.js';
const PHONE = '+14155551234';

describe('SMS addressing, encoding and provider acceptance', () => {
  it('normalizes explicit international and common US numbers, rejecting ambiguous input', () => {
    expect(normalizeE164('+1 (415) 555-1234')).toBe(PHONE);
    expect(normalizeE164('4155551234')).toBe(PHONE);
    expect(normalizeE164('14155551234')).toBe(PHONE);
    expect(normalizeE164('+442079460123')).toBe('+442079460123');
    expect(normalizeE164('call 4155551234')).toBeNull();
    expect(normalizeE164('442079460123')).toBeNull();
    expect(normalizeE164('+04155551234')).toBeNull();
    expect(maskPhone(PHONE)).toBe('••• ••• 1234');
  });
  it('counts GSM extensions and Unicode without splitting an escape or surrogate pair', () => {
    expect(smsSize('A'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    expect(smsSize('A'.repeat(161))).toMatchObject({ segments: 2 });
    expect(smsSize('^'.repeat(153))).toMatchObject({ units: 306, segments: 3 });
    expect(smsSize('界'.repeat(70))).toMatchObject({ encoding: 'UCS-2', segments: 1 });
    expect(smsSize('😀'.repeat(67))).toMatchObject({ units: 134, segments: 3 });
  });
  it('never sends an invalid or oversized SMS', async () => {
    const svc = new SmsService();
    const network = jest.fn();
    (svc as any).client = { send: network };
    expect((await svc.send(PHONE, '界'.repeat(202))).sent).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });
  it('holds an opted-out number and treats a lost publish response as uncertain', async () => {
    const before = {
      provider: process.env.TRACKER_SMS_PROVIDER,
      from: process.env.TRACKER_SMS_ORIGINATION_NUMBER,
    };
    process.env.TRACKER_SMS_PROVIDER = 'sns';
    process.env.TRACKER_SMS_ORIGINATION_NUMBER = '+14155550000';
    try {
      const svc = new SmsService(),
        send = jest.fn().mockResolvedValueOnce({ isOptedOut: true });
      (svc as any).client = { send };
      expect(await svc.send(PHONE, 'Reviewed update')).toMatchObject({
        sent: false,
        suppressed: true,
      });
      expect(send).toHaveBeenCalledTimes(1);
      send
        .mockResolvedValueOnce({ isOptedOut: false })
        .mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'AbortError' }));
      expect(await svc.send(PHONE, 'Reviewed update')).toMatchObject({
        sent: false,
        uncertain: true,
      });
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      if (before.provider === undefined) delete process.env.TRACKER_SMS_PROVIDER;
      else process.env.TRACKER_SMS_PROVIDER = before.provider;
      if (before.from === undefined) delete process.env.TRACKER_SMS_ORIGINATION_NUMBER;
      else process.env.TRACKER_SMS_ORIGINATION_NUMBER = before.from;
    }
  });
});
describe('TrackerWatchlistService.markPhoneVerified', () => {
  // Valid uuid — assertClientInTenant 404s non-uuid client ids outright.
  const CLIENT = '5b0c9c8e-2f1d-4e3a-9b6f-1a2b3c4d5e6f';

  /** Prisma stub modeling the PR-1 cross-tenant guards. */
  function guardedPrisma(opts: { clientInTenant: boolean; existingPrefTenant?: string | null }) {
    let upserted: any = null;
    const prisma = {
      // assertClientInTenant: bound-param read of `clients` under withSystem.
      withSystem: async (fn: any) =>
        fn({ $queryRawUnsafe: async () => (opts.clientInTenant ? [{ id: CLIENT }] : []) }),
      intelAlertPreference: {
        // assertPrefRowTenant: the update-branch tenant guard.
        findUnique: async () =>
          opts.existingPrefTenant ? { tenantId: opts.existingPrefTenant } : null,
        upsert: async (args: any) => {
          upserted = args;
          return args.create;
        },
      },
    } as any;
    prisma.withTenant = async (_tenant: string, fn: any) => fn(prisma);
    return { prisma, getUpserted: () => upserted };
  }

  it('upserts intel_alert_preference with verified+enabled (DEFAULT_TRIGGERS on create)', async () => {
    const { prisma, getUpserted } = guardedPrisma({ clientInTenant: true });
    await new TrackerWatchlistService(prisma).markPhoneVerified('t1', CLIENT, 'u1', PHONE);
    const upserted = getUpserted();
    expect(upserted.where).toEqual({ userId_clientId: { userId: 'u1', clientId: CLIENT } });
    expect(upserted.update).toEqual({ smsPhone: PHONE, smsPhoneVerified: true, smsEnabled: true });
    expect(upserted.create.triggers).toEqual([...DEFAULT_TRIGGERS]);
    expect(upserted.create.smsPhoneVerified).toBe(true);
    expect(upserted.create.tenantId).toBe('t1');
  });

  it("404s when the client is not in the caller's tenant (legacy assertClient parity)", async () => {
    const { prisma, getUpserted } = guardedPrisma({ clientInTenant: false });
    await expect(
      new TrackerWatchlistService(prisma).markPhoneVerified('t1', CLIENT, 'u1', PHONE),
    ).rejects.toThrow('Client not found');
    expect(getUpserted()).toBeNull(); // guard fires BEFORE the write
  });

  it('404s instead of mutating a pref row created under another tenant', async () => {
    const { prisma, getUpserted } = guardedPrisma({
      clientInTenant: true,
      existingPrefTenant: 'tenant-OTHER',
    });
    await expect(
      new TrackerWatchlistService(prisma).markPhoneVerified('t1', CLIENT, 'u1', PHONE),
    ).rejects.toThrow('Client not found');
    expect(getUpserted()).toBeNull();
  });

  it('404s a non-uuid clientId before touching the DB', async () => {
    const { prisma, getUpserted } = guardedPrisma({ clientInTenant: true });
    await expect(
      new TrackerWatchlistService(prisma).markPhoneVerified('t1', 'not-a-uuid', 'u1', PHONE),
    ).rejects.toThrow('Client not found');
    expect(getUpserted()).toBeNull();
  });
});
