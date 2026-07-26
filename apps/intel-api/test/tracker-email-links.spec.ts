import { Logger } from '@nestjs/common';
import {
  renderTestEmail,
  renderAlertEmail,
  rendererFor,
  ALERT_EMAIL_RENDERERS,
} from '../src/tracker/tracker-email.templates.js';
import { IntelAlertService } from '../src/intel-alert/intel-alert.service.js';
import type { IntelAlertEvent } from '../src/intel-alert/intel-alert.types.js';
import { TrackerTestAlertService } from '../src/tracker/tracker-test-alert.service.js';

/**
 * P1-06/P1-07, audit test-gap item 12 — corrected alert-email deep links,
 * LegiWatch naming, per-source renderer registry. Mirrors the hand-rolled
 * prisma-double style of intel-alert-shadow.spec.ts / intel-alert-digest.spec.ts
 * (no DB, no Nest TestingModule).
 */

const EVENT: IntelAlertEvent = {
  tenantId: 't1',
  clientId: 'c1',
  billId: '119-hr-1',
  displayNum: 'H.R. 1',
  billTitle: 'Test Act',
  changeType: 'bill_amendment',
  triggerKey: 'amendment',
  label: 'Amended',
  severity: 'notable',
  detail: 'Amended',
  actionDate: null,
  url: 'https://congress.gov/bill/119/hr1',
  matchedTags: [],
  score: 0.5,
  band: 'Med',
  appUrl: 'https://app.capiro.ai/legiwatch?tab=feed&client=c1',
};

describe('renderTestEmail (P1-06)', () => {
  it('the LegiWatch link is /legiwatch?tab=feed&client=<id> and never /clients/<id>?tab=tracker', () => {
    const { html } = renderTestEmail(
      'Acme Corp',
      'https://app.capiro.ai/legiwatch?tab=feed&client=c1',
      'https://app.capiro.ai/clients?clientId=c1&tab=tracker',
    );
    // esc() HTML-escapes the '&' between query params in an href attribute.
    expect(html).toContain('/legiwatch?tab=feed&amp;client=c1');
    expect(html).not.toContain('/clients/c1?tab=tracker');
  });

  it('also links the client-profile tracker tab as /clients?clientId=<id>&tab=tracker', () => {
    const { html } = renderTestEmail(
      'Acme Corp',
      'https://app.capiro.ai/legiwatch?tab=feed&client=c1',
      'https://app.capiro.ai/clients?clientId=c1&tab=tracker',
    );
    expect(html).toContain('/clients?clientId=c1&amp;tab=tracker');
  });
});

describe('renderAlertEmail (P1-06)', () => {
  it('with both appUrl and url renders two anchors: Open in LegiWatch + View official source', () => {
    const { html, text } = renderAlertEmail(EVENT);
    // esc() turns '&' into '&amp;' in the html attribute; the text part is unescaped.
    expect(html).toContain(`href="${EVENT.appUrl!.replace(/&/g, '&amp;')}"`);
    expect(html).toContain('Open in LegiWatch');
    expect(html).toContain(`href="${EVENT.url}"`);
    expect(html).toContain('View official source');
    expect(text).toContain(`Open in LegiWatch: ${EVENT.appUrl}`);
    expect(text).toContain(`View official source: ${EVENT.url}`);
  });

  it('with url only renders the official-source link, no LegiWatch link, and does not crash', () => {
    const noAppUrl: IntelAlertEvent = { ...EVENT, appUrl: undefined };
    const { html, text } = renderAlertEmail(noAppUrl);
    expect(html).toContain('View official source');
    expect(html).not.toContain('Open in LegiWatch');
    expect(text).not.toContain('Open in LegiWatch:');
    expect(text).toContain(`View official source: ${EVENT.url}`);
  });
});

describe('no rendered template names the old product or the old CTA (P1-06)', () => {
  it('renderTestEmail', () => {
    const { html, text, subject } = renderTestEmail('Acme', 'https://x/legiwatch', 'https://x/clients');
    for (const s of [html, text, subject]) {
      expect(s.toLowerCase()).not.toContain('bill tracker');
      expect(s.toLowerCase()).not.toContain('open in tracker');
    }
  });

  it('renderAlertEmail', () => {
    const { html, text, subject } = renderAlertEmail(EVENT);
    for (const s of [html, text, subject]) {
      expect(s.toLowerCase()).not.toContain('bill tracker');
      expect(s.toLowerCase()).not.toContain('open in tracker');
    }
  });
});

describe('rendererFor (P1-07)', () => {
  it("returns null for a source with no registered renderer ('program_element')", () => {
    expect(rendererFor('program_element')).toBeNull();
  });
  it("returns a function for 'bill'", () => {
    expect(rendererFor('bill')).toBe(ALERT_EMAIL_RENDERERS.bill);
  });
  it('defaults to the bill renderer when sourceType is undefined', () => {
    expect(rendererFor(undefined)).toBe(ALERT_EMAIL_RENDERERS.bill);
  });
});

/** fanOut's renderer-registry gate — mirrors intel-alert-shadow.spec.ts's harness. */
describe('IntelAlertService.fanOut — renderer registry (P1-07)', () => {
  function makeService(sourceType: string | undefined) {
    const claims: Array<{ status: string }> = [];
    const sendCalls: string[] = [];
    const inner = {
      intelAlertPreference: {
        findMany: async () => [
          {
            userId: 'u1',
            triggers: ['amendment'],
            materiality: 'medium',
            jurisdictions: [],
            emailEnabled: true,
            emailAddress: 'u1@x.com',
            emailCadence: 'realtime',
          },
        ],
      },
      intelNotificationLog: {
        create: async ({ data }: { data: { status: string } }) => {
          claims.push({ status: data.status });
          return { id: 'log1' };
        },
        update: async () => ({}),
      },
    };
    const prisma = {
      ...inner,
      withTenant: async <T>(_tid: string, cb: (tx: typeof inner) => Promise<T>) => cb(inner),
      withSystem: async <T>(cb: (tx: typeof inner) => Promise<T>) => cb(inner),
    };
    const flags = { isEnabled: async () => true };
    const email = {
      send: async (to: string) => {
        sendCalls.push(to);
        return { sent: true, messageId: 'm1' };
      },
    };
    const svc = new IntelAlertService(
      prisma as never,
      flags as never,
      email as never,
      {} as never,
      { configured: false } as never,
    );
    const event: IntelAlertEvent = { ...EVENT, sourceType };
    return { svc, event, claims, sendCalls };
  }

  it('sourceType=program_element: email.send NOT called, returns all-zeros, logs a warning', async () => {
    process.env.TRACKER_ALERTS_ENABLED = 'true';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, event, claims, sendCalls } = makeService('program_element');
    const r = await svc.fanOut(event);
    expect(r).toEqual({ suppressed: 0, sent: 0, failed: 0, queued: 0 });
    expect(sendCalls).toEqual([]);
    expect(claims).toEqual([]); // never reaches the per-pref loop, so no claim either
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no email renderer for sourceType='program_element'"));
    warnSpy.mockRestore();
    delete process.env.TRACKER_ALERTS_ENABLED;
  });

  it('sourceType=bill: unchanged send behavior (regression lock)', async () => {
    process.env.TRACKER_ALERTS_ENABLED = 'true';
    const { svc, event, sendCalls } = makeService('bill');
    const r = await svc.fanOut(event);
    expect(r.sent).toBe(1);
    expect(sendCalls).toEqual(['u1@x.com']);
    delete process.env.TRACKER_ALERTS_ENABLED;
  });
});

describe('TrackerTestAlertService — client id percent-encoding (P1-06)', () => {
  it('a clientId containing & ? and a space is percent-encoded in both the LegiWatch and client-profile URLs', async () => {
    const clientId = 'c&1?x y';
    const prisma = {
      withTenant: async <T>(_t: string, cb: (tx: unknown) => Promise<T>) =>
        cb({
          intelAlertPreference: {
            findUnique: async () => ({
              tenantId: 't1',
              userId: 'u1',
              clientId,
              emailEnabled: true,
              emailAddress: 'u1@x.com',
              smsEnabled: false,
              smsPhoneVerified: false,
              smsPhone: null,
            }),
          },
        }),
    };
    const repo = { getClientProfile: async () => ({ name: 'Acme Corp' }) };
    let sentHtml = '';
    let sentText = '';
    const email = {
      send: async (_to: string, _subject: string, html: string, text: string) => {
        sentHtml = html;
        sentText = text;
        return { sent: true, messageId: 'm1' };
      },
    };
    const sms = { send: async () => ({ sent: false, dormant: true }) };
    const svc = new TrackerTestAlertService(prisma as never, repo as never, email as never, sms as never);
    const out = await svc.sendTestAlert('t1', clientId, 'u1', ['email']);
    expect(out).toEqual([{ channel: 'email', status: 'sent' }]);
    const encoded = encodeURIComponent(clientId);
    // html attributes are HTML-escaped (esc() turns the literal '&' between
    // query params into '&amp;'); the encoded clientId itself contains no
    // '&'/'<'/'>'/'"' (encodeURIComponent percent-escapes those), so it is
    // checked verbatim. The text part is unescaped, so the full query string
    // with a literal '&' is checked there.
    expect(sentHtml).toContain(`client=${encoded}`);
    expect(sentHtml).toContain(`clientId=${encoded}`);
    expect(sentText).toContain(`/legiwatch?tab=feed&client=${encoded}`);
    expect(sentText).toContain(`/clients?clientId=${encoded}&tab=tracker`);
  });
});
