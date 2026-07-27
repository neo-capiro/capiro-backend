import { Logger } from '@nestjs/common';
import {
  renderTestEmail,
  renderAlertEmail,
  renderDigestEmail,
  renderHearingAlertEmail,
  renderCombinedAlertEmail,
  renderRegulationAlertEmail,
  renderProgramElementAlertEmail,
  rendererFor,
  ALERT_EMAIL_RENDERERS,
  type DigestItem,
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

/** A minimal, complete DigestItem fixture (RB-03 / MP-01). */
function digestItem(over: Partial<DigestItem> = {}): DigestItem {
  return {
    clientName: 'Acme Corp',
    displayNum: 'H.R. 1',
    billTitle: 'Test Act',
    label: 'Amended',
    severity: 'notable',
    detail: 'Amended',
    actionDate: null,
    deadline: null,
    recommendedAction: null,
    why: null,
    url: '',
    appUrl: 'https://app.capiro.ai/legiwatch?tab=feed&client=c1&alert=a1',
    ...over,
  };
}

describe('renderDigestEmail (RB-03)', () => {
  it('the LegiWatch link is /legiwatch?tab=feed&client=<id>&alert=<id> and never /clients/<id>?tab=tracker', () => {
    const { html, text } = renderDigestEmail('daily', [digestItem()]);
    expect(html).toContain('/legiwatch?tab=feed&amp;client=c1&amp;alert=a1');
    expect(text).toContain('/legiwatch?tab=feed&client=c1&alert=a1');
    expect(html).not.toContain('/clients/c1?tab=tracker');
    expect(text).not.toContain('/clients/c1?tab=tracker');
  });
});

/**
 * Gate G a-4: generic across EVERY renderer, so the next one added (HP-07's
 * per-source renderers) cannot regress this without failing here first.
 */
describe('every email renderer — never the /clients/<id>?tab= anti-pattern (RB-03)', () => {
  it('renderTestEmail', () => {
    const { html, text } = renderTestEmail(
      'Acme Corp',
      'https://app.capiro.ai/legiwatch?tab=feed&client=c1',
      'https://app.capiro.ai/clients?clientId=c1&tab=tracker', // the CORRECT query-param route
    );
    expect(html).not.toMatch(/\/clients\/[^?]+\?tab=/);
    expect(text).not.toMatch(/\/clients\/[^?]+\?tab=/);
  });

  it('renderAlertEmail', () => {
    const { html, text } = renderAlertEmail(EVENT);
    expect(html).not.toMatch(/\/clients\/[^?]+\?tab=/);
    expect(text).not.toMatch(/\/clients\/[^?]+\?tab=/);
  });

  it('renderDigestEmail', () => {
    const { html, text } = renderDigestEmail('weekly', [digestItem({ appUrl: 'https://app.capiro.ai/legiwatch?tab=feed&client=c9&alert=a9' })]);
    expect(html).not.toMatch(/\/clients\/[^?]+\?tab=/);
    expect(text).not.toMatch(/\/clients\/[^?]+\?tab=/);
  });

  // HP-07 (Gate G phase e): the 4 renderers this gate adds.
  it('renderHearingAlertEmail', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'hearing',
      hearing: {
        sessionId: 's1',
        title: 'Full Committee Markup',
        committeeId: 'HASC',
        occurredAt: '2026-07-01T14:00:00.000Z',
        mentions: [{ speakerName: 'Rep. X', quote: 'We need to address this.', timestampMs: 1000 }],
      },
    };
    const { html, text } = ALERT_EMAIL_RENDERERS.hearing!(event);
    expect(html).not.toMatch(/\/clients\/[^?]+\?tab=/);
    expect(text).not.toMatch(/\/clients\/[^?]+\?tab=/);
  });

  it('renderCombinedAlertEmail', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'combined',
      linkedBill: {
        displayNum: 'H.R. 1',
        title: 'Test Act',
        url: 'https://congress.gov/bill/119/hr1',
        actionText: 'Referenced in hearing',
        actionDate: '2026-07-01',
      },
      hearing: { sessionId: 's1', title: 'Full Committee Markup', committeeId: 'HASC', occurredAt: null, mentions: [] },
    };
    const { html, text } = ALERT_EMAIL_RENDERERS.combined!(event);
    expect(html).not.toMatch(/\/clients\/[^?]+\?tab=/);
    expect(text).not.toMatch(/\/clients\/[^?]+\?tab=/);
  });

  it('renderRegulationAlertEmail', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'regulation',
      regulationInfo: { agency: 'EPA', ruleType: 'proposed', commentEndDate: '2026-08-01', jurisdiction: 'US' },
    };
    const { html, text } = ALERT_EMAIL_RENDERERS.regulation!(event);
    expect(html).not.toMatch(/\/clients\/[^?]+\?tab=/);
    expect(text).not.toMatch(/\/clients\/[^?]+\?tab=/);
  });

  it('renderProgramElementAlertEmail', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'program_element',
      programElement: {
        peCode: '0603286F',
        title: 'Hypersonics Prototyping',
        fiscalYear: 2027,
        deltaTypeLabel: 'New start',
        amountFromMillions: 0,
        amountToMillions: 12,
        deltaMillions: 12,
        deltaPct: null,
        href: '/program-elements/0603286F',
      },
    };
    const { html, text } = ALERT_EMAIL_RENDERERS.program_element!(event);
    expect(html).not.toMatch(/\/clients\/[^?]+\?tab=/);
    expect(text).not.toMatch(/\/clients\/[^?]+\?tab=/);
  });
});

describe('HP-07 per-source renderers — content (Gate G phase e)', () => {
  it('renderHearingAlertEmail: no official-source link (none exists for this type), shows mentions', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'hearing',
      billTitle: 'Full Committee Markup — 1 watchlist mention',
      detail: 'Your watchlist term(s) were referenced in this hearing.',
      hearing: {
        sessionId: 's1',
        title: 'Full Committee Markup',
        committeeId: 'HASC',
        occurredAt: '2026-07-01T14:00:00.000Z',
        mentions: [{ speakerName: 'Rep. X', quote: 'We need to address this.', timestampMs: 1000 }],
      },
    };
    const { html, text, subject } = renderHearingAlertEmail(event);
    expect(subject).toContain('Full Committee Markup — 1 watchlist mention');
    expect(html).toContain('Rep. X');
    expect(html).toContain('We need to address this.');
    expect(html).not.toContain('View official source');
    expect(text).toContain('Rep. X: We need to address this.');
  });

  it('renderHearingAlertEmail: an encrypted (undecrypted) mention shows a pending notice, not a crash', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'hearing',
      hearing: {
        sessionId: 's1',
        title: 'Hearing',
        committeeId: null,
        occurredAt: null,
        mentions: [{ speakerName: null, quote: null, timestampMs: null }],
      },
    };
    const { html, text } = renderHearingAlertEmail(event);
    expect(html).toContain('Content pending decryption');
    expect(text).toContain('(content pending decryption)');
  });

  it('renderCombinedAlertEmail: official source is the LINKED BILL\'s url, and shows the hearing context', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'combined',
      linkedBill: {
        displayNum: 'H.R. 8800',
        title: 'National Defense Manufacturing Act',
        url: 'https://congress.gov/bill/hr8800',
        actionText: 'Rules Committee granted a closed rule',
        actionDate: '2026-07-01',
      },
      hearing: { sessionId: 's1', title: 'FY27 Posture Hearing', committeeId: 'HASC', occurredAt: null, mentions: [] },
    };
    const { html, text, subject } = renderCombinedAlertEmail(event);
    expect(subject).toContain('H.R. 8800');
    expect(html).toContain(`href="${event.linkedBill!.url}"`);
    expect(html).toContain('View official source');
    expect(html).toContain('FY27 Posture Hearing');
    expect(text).toContain(`View official source: ${event.linkedBill!.url}`);
  });

  it('renderRegulationAlertEmail: shows agency/ruleType and the comment-period deadline', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'regulation',
      billTitle: 'New matched rule: PFAS Drinking Water Standard',
      url: 'https://federalregister.gov/d/2026-12345',
      regulationInfo: { agency: 'EPA', ruleType: 'final', commentEndDate: '2026-08-15', jurisdiction: 'US' },
    };
    const { html, text } = renderRegulationAlertEmail(event);
    expect(html).toContain('EPA');
    expect(html).toContain('final');
    expect(html).toContain('2026-08-15');
    expect(html).toContain(`href="${event.url}"`);
    expect(text).toContain('Comment period ends: 2026-08-15');
  });

  it('renderRegulationAlertEmail: never assumes docketId/effectiveDate exist (writer never sets them)', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'regulation',
      regulationInfo: { agency: null, ruleType: null, commentEndDate: null, jurisdiction: 'US' },
    };
    expect(() => renderRegulationAlertEmail(event)).not.toThrow();
  });

  it('renderProgramElementAlertEmail: shows the funding move and links the internal PE-360 dossier, not an official source', () => {
    const event: IntelAlertEvent = {
      ...EVENT,
      sourceType: 'program_element',
      billTitle: 'FY2027 New start: 0603286F Hypersonics Prototyping ($0.0M → $12.0M)',
      programElement: {
        peCode: '0603286F',
        title: 'Hypersonics Prototyping',
        fiscalYear: 2027,
        deltaTypeLabel: 'New start',
        amountFromMillions: 0,
        amountToMillions: 12,
        deltaMillions: 12,
        deltaPct: null,
        href: '/program-elements/0603286F',
      },
    };
    const { html, text } = renderProgramElementAlertEmail(event);
    expect(html).toContain('$0.0M → $12.0M');
    expect(html).toContain('FY2027');
    expect(html).toContain('Open Program Element');
    expect(html).toContain('href="https://app.capiro.ai/program-elements/0603286F"');
    expect(html).not.toContain('View official source');
    expect(text).toContain('Open Program Element: https://app.capiro.ai/program-elements/0603286F');
  });
});

describe('rendererFor (P1-07, HP-07)', () => {
  // HP-07 (Gate G phase e): all 6 canonical source types now have a
  // renderer — there is no longer a real "known source, no renderer" case to
  // lock on, so this asserts the true regression: an UNKNOWN string still
  // safely resolves to null rather than crashing fanOut.
  it('returns null for an unregistered/unknown source type', () => {
    expect(rendererFor('not_a_real_source_type')).toBeNull();
  });
  it("returns a function for 'bill'", () => {
    expect(rendererFor('bill')).toBe(ALERT_EMAIL_RENDERERS.bill);
  });
  it('defaults to the bill renderer when sourceType is undefined', () => {
    expect(rendererFor(undefined)).toBe(ALERT_EMAIL_RENDERERS.bill);
  });
  it.each(['hearing', 'combined', 'regulation', 'program_element'] as const)(
    "returns the %s-specific renderer, registered by HP-07 (Gate G phase e)",
    (sourceType) => {
      expect(rendererFor(sourceType)).toBe(ALERT_EMAIL_RENDERERS[sourceType]);
    },
  );
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

  it('sourceType=not_a_real_source_type: email.send NOT called, returns all-zeros, logs a warning', async () => {
    process.env.TRACKER_ALERTS_ENABLED = 'true';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, event, claims, sendCalls } = makeService('not_a_real_source_type');
    const r = await svc.fanOut(event);
    expect(r).toEqual({ suppressed: 0, sent: 0, failed: 0, queued: 0 });
    expect(sendCalls).toEqual([]);
    expect(claims).toEqual([]); // never reaches the per-pref loop, so no claim either
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no email renderer for sourceType='not_a_real_source_type'"));
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

  // HP-07 (Gate G phase e): a renderer now exists for these 4, so fanOut (if
  // ever reached for one — today it's only reached via emitNewBillAlerts'
  // LEGIWATCH_EMIT_SOURCE_TYPES-gated sweep, per intel-alert.service.ts's
  // own call site) sends exactly like 'bill' does, not the no-renderer skip.
  it.each(['hearing', 'combined', 'regulation', 'program_element'] as const)(
    'sourceType=%s: HP-07 renderer registered, email.send IS called (not the no-renderer skip)',
    async (sourceType) => {
      process.env.TRACKER_ALERTS_ENABLED = 'true';
      const { svc, event, sendCalls } = makeService(sourceType);
      const r = await svc.fanOut(event);
      expect(r.sent).toBe(1);
      expect(sendCalls).toEqual(['u1@x.com']);
      delete process.env.TRACKER_ALERTS_ENABLED;
    },
  );
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
