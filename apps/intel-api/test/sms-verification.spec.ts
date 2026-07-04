import { BadRequestException } from '@nestjs/common';
import { SmsVerificationService, hashCode } from '../src/tracker/sms/sms-verification.service.js';
import { SmsService, maskPhone, normalizeE164 } from '../src/tracker/sms/sms.service.js';
import { TrackerWatchlistService, DEFAULT_TRIGGERS } from '../src/tracker/tracker-watchlist.service.js';

/**
 * P1.1 — SMS phone verification (the consent step for the SMS channel), ported
 * from apps/api. Pure-unit with mocked prisma; the SmsService itself is dormant
 * in tests (TRACKER_SMS_PROVIDER unset), which is also the prod posture.
 */
const PHONE = '+14155551234';

beforeAll(() => {
  // Pin the dormant + non-prod posture the assertions depend on.
  process.env.TRACKER_SMS_PROVIDER = 'none';
  process.env.NODE_ENV = 'test';
});

function mockPrisma() {
  const created: any[] = [];
  const updates: any[] = [];
  let findFirstRow: any = null;
  const prisma = {
    intelSmsVerification: {
      create: async (args: any) => {
        created.push(args.data);
        return { id: 'v1', ...args.data };
      },
      findFirst: async () => findFirstRow,
      update: async (args: any) => {
        updates.push(args);
        return { ...findFirstRow, ...args.data };
      },
    },
  } as any;
  return { prisma, created, updates, setRow: (r: any) => (findFirstRow = r) };
}

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'v1',
  tenantId: 't1',
  userId: 'u1',
  phone: PHONE,
  codeHash: hashCode('123456', PHONE),
  expiresAt: new Date(Date.now() + 60_000),
  consumed: false,
  attempts: 0,
  createdAt: new Date(),
  ...over,
});

describe('normalizeE164 / maskPhone', () => {
  it('coerces common US forms to E.164 and rejects junk', () => {
    expect(normalizeE164('+1 (415) 555-1234')).toBe(PHONE);
    expect(normalizeE164('4155551234')).toBe(PHONE);
    expect(normalizeE164('14155551234')).toBe(PHONE);
    expect(normalizeE164('12345')).toBeNull();
  });
  it('masks all but the last 4 digits', () => {
    expect(maskPhone(PHONE)).toBe('+1 (•••) •••-1234');
  });
});

describe('SmsVerificationService.startVerification', () => {
  it('stores a hashed (never plaintext) OTP and returns devCode when dormant + non-prod', async () => {
    const { prisma, created } = mockPrisma();
    const svc = new SmsVerificationService(prisma, new SmsService());
    const res = await svc.startVerification('t1', 'u1', 'c1', PHONE);
    expect(res.dormant).toBe(true); // no TRACKER_SMS_PROVIDER in tests
    expect(res.masked).toBe('+1 (•••) •••-1234');
    expect(res.devCode).toMatch(/^\d{6}$/); // NODE_ENV=test → surfaced
    expect(created).toHaveLength(1);
    expect(created[0].codeHash).toBe(hashCode(res.devCode!, PHONE));
    expect(created[0].codeHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex, not the code
    expect(created[0].tenantId).toBe('t1');
  });

  it('rejects an unparseable phone', async () => {
    const { prisma } = mockPrisma();
    const svc = new SmsVerificationService(prisma, new SmsService());
    await expect(svc.startVerification('t1', 'u1', null, 'nope')).rejects.toThrow(BadRequestException);
  });
});

describe('SmsVerificationService.confirmVerification', () => {
  it('hash mismatch increments attempts and rejects', async () => {
    const { prisma, updates, setRow } = mockPrisma();
    setRow(row());
    const svc = new SmsVerificationService(prisma, new SmsService());
    await expect(svc.confirmVerification('t1', 'u1', PHONE, '000000')).rejects.toThrow('Incorrect code');
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual({ attempts: { increment: 1 } });
  });

  it('rejects an expired code without consuming it', async () => {
    const { prisma, updates, setRow } = mockPrisma();
    setRow(row({ expiresAt: new Date(Date.now() - 1000) }));
    const svc = new SmsVerificationService(prisma, new SmsService());
    await expect(svc.confirmVerification('t1', 'u1', PHONE, '123456')).rejects.toThrow('expired');
    expect(updates).toHaveLength(0);
  });

  it('rejects after MAX_ATTEMPTS', async () => {
    const { prisma, setRow } = mockPrisma();
    setRow(row({ attempts: 5 }));
    const svc = new SmsVerificationService(prisma, new SmsService());
    await expect(svc.confirmVerification('t1', 'u1', PHONE, '123456')).rejects.toThrow('Too many attempts');
  });

  it('success consumes the row and returns the normalized phone', async () => {
    const { prisma, updates, setRow } = mockPrisma();
    setRow(row());
    const svc = new SmsVerificationService(prisma, new SmsService());
    const res = await svc.confirmVerification('t1', 'u1', '+1 (415) 555-1234', '123456');
    expect(res).toEqual({ verified: true, phone: PHONE });
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual({ consumed: true });
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
    const { prisma, getUpserted } = guardedPrisma({ clientInTenant: true, existingPrefTenant: 'tenant-OTHER' });
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
