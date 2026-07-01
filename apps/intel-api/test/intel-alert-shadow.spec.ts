import { clearsMateriality, isWithinQuietHours } from '../src/intel-alert/intel-alert.types.js';
import { IntelAlertService } from '../src/intel-alert/intel-alert.service.js';
import type { IntelAlertEvent } from '../src/intel-alert/intel-alert.types.js';

describe('clearsMateriality', () => {
  it('passes when severity rank >= materiality floor', () => {
    expect(clearsMateriality('critical', 'high')).toBe(true);
    expect(clearsMateriality('notable', 'high')).toBe(false);
    expect(clearsMateriality('notable', 'medium')).toBe(true);
    expect(clearsMateriality('info', 'low')).toBe(true);
    expect(clearsMateriality('info', 'medium')).toBe(false);
  });
});

describe('isWithinQuietHours', () => {
  // 03:00 ET
  const at3amEt = new Date('2026-03-10T08:00:00Z'); // 08:00 UTC = 03:00 EST
  it('handles the midnight-wrap window 22:00–07:00', () => {
    expect(isWithinQuietHours('22:00', '07:00', at3amEt)).toBe(true);
    expect(isWithinQuietHours('07:00', '22:00', at3amEt)).toBe(false);
  });
  it('returns false when unset/invalid', () => {
    expect(isWithinQuietHours(null, '07:00', at3amEt)).toBe(false);
  });
});

/**
 * The single-sender shadow guarantee (plan §7.4 / S2): fanOut for a NOT-owned
 * tenant with the kill-switch off must claim `suppressed_shadow` and NEVER call
 * email.send().
 */
describe('IntelAlertService.fanOut (shadow)', () => {
  const event: IntelAlertEvent = {
    tenantId: 't1', clientId: 'c1', billId: '119-hr-1', displayNum: 'H.R. 1', billTitle: 'Test',
    changeType: 'bill_amendment', triggerKey: 'amendment', label: 'Amended', severity: 'notable',
    detail: 'Amended', actionDate: null, url: '', matchedTags: [], score: 0.5, band: 'Med',
  };

  function makeService(owned: boolean) {
    const claims: Array<{ status: string; channel: string }> = [];
    const sendCalls: string[] = [];
    const prisma = {
      intelAlertPreference: {
        findMany: async () => [{ userId: 'u1', triggers: ['amendment'], materiality: 'medium', emailEnabled: true, emailAddress: 'u1@x.com' }],
      },
      intelNotificationLog: {
        create: async ({ data }: { data: { status: string; channel: string } }) => {
          claims.push({ status: data.status, channel: data.channel });
          return { id: 'log1' };
        },
        update: async () => ({}),
      },
    };
    const flags = { isEnabled: async () => owned };
    const email = { send: async (to: string) => { sendCalls.push(to); return { sent: true, messageId: 'm1' }; } };
    const svc = new IntelAlertService(prisma as never, flags as never, email as never);
    return { svc, claims, sendCalls };
  }

  it('suppresses (no send) when not owned', async () => {
    delete process.env.TRACKER_ALERTS_ENABLED;
    const { svc, claims, sendCalls } = makeService(false);
    const r = await svc.fanOut(event);
    expect(r).toEqual({ suppressed: 1, sent: 0 });
    expect(claims).toEqual([{ status: 'suppressed_shadow', channel: 'email' }]);
    expect(sendCalls).toEqual([]); // NEVER sent
  });

  it('suppresses even when owned if the TRACKER_ALERTS_ENABLED kill-switch is off', async () => {
    delete process.env.TRACKER_ALERTS_ENABLED; // kill-switch off (shadow default)
    const { svc, claims, sendCalls } = makeService(true); // owned (e.g. internal tenant)
    const r = await svc.fanOut(event);
    expect(r.sent).toBe(0);
    expect(sendCalls).toEqual([]); // still NEVER sent — kill-switch wins
    expect(claims[0].status).toBe('suppressed_shadow');
  });

  it('skips prefs that fail the trigger/materiality gate', async () => {
    delete process.env.TRACKER_ALERTS_ENABLED;
    const claims: string[] = [];
    const prisma = {
      intelAlertPreference: { findMany: async () => [{ userId: 'u1', triggers: ['hearing'], materiality: 'medium', emailEnabled: true, emailAddress: 'u1@x.com' }] },
      intelNotificationLog: { create: async () => { claims.push('x'); return { id: 'l' }; }, update: async () => ({}) },
    };
    const svc = new IntelAlertService(prisma as never, { isEnabled: async () => false } as never, { send: async () => ({ sent: true }) } as never);
    const r = await svc.fanOut(event); // event.triggerKey='amendment' not in ['hearing']
    expect(r).toEqual({ suppressed: 0, sent: 0 });
    expect(claims).toEqual([]);
  });
});
