// Engagement Phase 0 (plan §3.e3) — Microsoft delivery is traceable BEFORE send.
//
// Change-controlled file; this spec covers ONLY the sendMail branch (create draft
// → send draft). Sync, token, subscription and notification paths are deliberately
// untouched and untested here.
//
// The three outcomes that matter:
//   1. create + send succeed → draft id returned, so the message is reconcilable;
//   2. create FAILS           → an ordinary provider failure (nothing was sent);
//   3. create succeeds, send is ambiguous → AmbiguousMailSendError carrying the
//      draft id, so the caller records 'unknown' and does NOT retry.

import { describe, expect, test } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  MicrosoftGraphSyncService,
  isAmbiguousGraphSendFailure,
  sanitizeGraphHeaderValue,
} from './microsoft-graph-sync.service.js';
import { AmbiguousMailSendError } from '../mail-send-result.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

const CORRELATION = 'b3f1c2d4-1111-4222-8333-444455556666';
const INPUT = {
  subject: 'Funding update',
  body: '<p>Hello</p>',
  bodyContentType: 'HTML' as const,
  toRecipients: [{ email: 'a@x.com', name: 'A' }],
  correlationId: CORRELATION,
};

interface Call {
  url: string;
  body: unknown;
}

function makeService(opts: {
  draftResponse?: unknown;
  draftThrows?: unknown;
  sendThrows?: unknown;
}) {
  const calls: Call[] = [];
  const service = Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.assertConnectionAccess = async () => {};
  patch.loadConnection = async () => ({ token: {} });
  patch.getValidAccessToken = async () => 'access-token';
  patch.graphPost = async (url: string, _t: string, body: unknown) => {
    calls.push({ url, body });
    if (opts.draftThrows) throw opts.draftThrows;
    return opts.draftResponse ?? { id: 'draft-1', internetMessageId: '<abc@contoso.com>' };
  };
  patch.graphPostNoContent = async (url: string, _t: string, body: unknown) => {
    calls.push({ url, body });
    if (opts.sendThrows) throw opts.sendThrows;
  };
  return { service, calls };
}

describe('sanitizeGraphHeaderValue', () => {
  test('a UUID passes; injection attempts and overlong values are dropped', () => {
    expect(sanitizeGraphHeaderValue(CORRELATION)).toBe(CORRELATION);
    expect(sanitizeGraphHeaderValue('a\r\nX-Evil: 1')).toBeNull();
    expect(sanitizeGraphHeaderValue('has spaces')).toBeNull();
    expect(sanitizeGraphHeaderValue('x'.repeat(200))).toBeNull();
    expect(sanitizeGraphHeaderValue(undefined)).toBeNull();
  });
});

describe('isAmbiguousGraphSendFailure', () => {
  test('an HTTP status answer is NOT ambiguous — Graph told us what happened', () => {
    expect(isAmbiguousGraphSendFailure(new ServiceUnavailableException('Graph 400 bad request'))).toBe(
      false,
    );
  });

  test('transport failures ARE ambiguous', () => {
    expect(isAmbiguousGraphSendFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isAmbiguousGraphSendFailure(new Error('socket hang up'))).toBe(true);
    expect(isAmbiguousGraphSendFailure(new Error('read ECONNRESET'))).toBe(true);
    expect(isAmbiguousGraphSendFailure(new Error('request timeout'))).toBe(true);
  });
});

describe('sendMail — create draft then send', () => {
  test('creates the draft FIRST, then sends it, and returns the draft id', async () => {
    const h = makeService({});
    const out = await h.service.sendMail(ctx, 'conn-1', INPUT);
    expect(h.calls.map((c) => c.url)).toEqual(['/me/messages', '/me/messages/draft-1/send']);
    expect(out).toEqual({
      ok: true,
      provider: 'microsoft_graph',
      providerDraftId: 'draft-1',
      providerInternetMessageId: '<abc@contoso.com>',
      correlationId: CORRELATION,
    });
  });

  test('the draft carries the X-Capiro-Delivery-Id internetMessageHeader', async () => {
    const h = makeService({});
    await h.service.sendMail(ctx, 'conn-1', INPUT);
    const draftBody = h.calls[0]!.body as Record<string, unknown>;
    expect(draftBody.internetMessageHeaders).toEqual([
      { name: 'X-Capiro-Delivery-Id', value: CORRELATION },
    ]);
  });

  test('subject/body/To/attachments are still passed through unchanged', async () => {
    const h = makeService({});
    await h.service.sendMail(ctx, 'conn-1', {
      ...INPUT,
      ccRecipients: [{ email: 'c@x.com' }],
      bccRecipients: [{ email: 'b@x.com' }],
      attachments: [{ name: 'f.pdf', contentType: 'application/pdf', contentBytes: 'AAA' }],
    });
    const draft = h.calls[0]!.body as Record<string, unknown>;
    expect(draft.subject).toBe('Funding update');
    expect(draft.body).toEqual({ contentType: 'HTML', content: '<p>Hello</p>' });
    expect(draft.toRecipients).toEqual([{ emailAddress: { address: 'a@x.com', name: 'A' } }]);
    expect(draft.ccRecipients).toEqual([{ emailAddress: { address: 'c@x.com' } }]);
    expect(draft.bccRecipients).toEqual([{ emailAddress: { address: 'b@x.com' } }]);
    expect((draft.attachments as unknown[])[0]).toMatchObject({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'f.pdf',
    });
  });

  test('no header is added when there is no correlation id', async () => {
    const h = makeService({});
    await h.service.sendMail(ctx, 'conn-1', { ...INPUT, correlationId: undefined });
    expect(h.calls[0]!.body).not.toHaveProperty('internetMessageHeaders');
  });

  test('DRAFT CREATION FAILURE is an ordinary provider failure — nothing was sent', async () => {
    const boom = new ServiceUnavailableException('Graph POST /me/messages failed (400): bad');
    const h = makeService({ draftThrows: boom });
    await expect(h.service.sendMail(ctx, 'conn-1', INPUT)).rejects.toBe(boom);
    // The send step was never reached.
    expect(h.calls.map((c) => c.url)).toEqual(['/me/messages']);
  });

  test('a draft response with NO id fails without sending', async () => {
    const h = makeService({ draftResponse: { internetMessageId: '<x>' } });
    await expect(h.service.sendMail(ctx, 'conn-1', INPUT)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(h.calls.map((c) => c.url)).toEqual(['/me/messages']);
  });

  test('draft created + AMBIGUOUS send → AmbiguousMailSendError carrying the draft id', async () => {
    const h = makeService({ sendThrows: new TypeError('fetch failed') });
    let caught: unknown;
    try {
      await h.service.sendMail(ctx, 'conn-1', INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AmbiguousMailSendError);
    const err = caught as AmbiguousMailSendError;
    expect(err.providerDraftId).toBe('draft-1');
    expect(err.correlationId).toBe(CORRELATION);
    // Carries ids only — never message content.
    expect(err.message).not.toContain('Hello');
  });

  test('draft created + a DETERMINISTIC send rejection stays an ordinary failure', async () => {
    const boom = new ServiceUnavailableException('Graph POST /send failed (403): forbidden');
    const h = makeService({ sendThrows: boom });
    await expect(h.service.sendMail(ctx, 'conn-1', INPUT)).rejects.toBe(boom);
  });

  test('the draft id is URL-encoded into the send path', async () => {
    const h = makeService({ draftResponse: { id: 'AAMk/id+with=chars' } });
    await h.service.sendMail(ctx, 'conn-1', INPUT);
    expect(h.calls[1]!.url).toBe(`/me/messages/${encodeURIComponent('AAMk/id+with=chars')}/send`);
  });
});
