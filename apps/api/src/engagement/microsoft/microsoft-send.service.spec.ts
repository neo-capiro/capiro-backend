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
  GraphHttpError,
  MicrosoftGraphSyncService,
  isAmbiguousGraphSendFailure,
  sanitizeGraphHeaderValue,
} from './microsoft-graph-sync.service.js';
import { AmbiguousMailSendError } from '../mail-send-result.js';
import { isDefiniteMailSendRejection } from '../mail-send-result.js';

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

test('native Outlook reply creates a reply draft instead of a new-message draft', async () => {
  const h = makeReplyService();
  await h.service.sendMail(ctx, 'conn-1', h.input);
  expect(h.calls[0]!.url).toBe('/me/messages/original-immutable/createReply');
  expect(h.calls.map(c => c.url)).toEqual(['/me/messages/original-immutable/createReply', '/me/messages/draft-1/send']);
  expect(Buffer.from(h.calls[0]!.body as string, 'base64').toString()).toContain('In-Reply-To: <original@x.com>');
});

function makeReplyService() {
  const h = makeService({ draftResponse: { id: 'draft-1', conversationId: 'reply-conversation' } });
  const recipient = (address: string) => ({ emailAddress: { address } });
  const reply = { kind: 'microsoft_graph' as const, immutableId: 'original-immutable', conversationId: 'original-conversation',
    changeKey: 'original-version', subject: INPUT.subject, fromEmail: 'a@x.com', senderEmail: 'a@x.com',
    toEmail: 'a@x.com', replyTo: [] as string[], inReplyTo: '<original@x.com>', references: '<original@x.com>' };
  const original = { id: reply.immutableId, conversationId: reply.conversationId, changeKey: reply.changeKey, isDraft: false,
    subject: reply.subject, from: recipient(reply.fromEmail), sender: recipient(reply.senderEmail), replyTo: [], internetMessageId: reply.inReplyTo,
    internetMessageHeaders: [{ name: 'Message-ID', value: reply.inReplyTo }] };
  const draft: any = { id: 'draft-1', conversationId: 'reply-conversation', isDraft: true, subject: INPUT.subject,
    body: { contentType: 'html', content: INPUT.body }, from: recipient('sender@example.test'), sender: recipient('sender@example.test'),
    toRecipients: [recipient('a@x.com')], ccRecipients: [], bccRecipients: [], replyTo: [], hasAttachments: false,
    internetMessageHeaders: [{ name: 'X-Capiro-Delivery-Id', value: CORRELATION }, { name: 'In-Reply-To', value: reply.inReplyTo }, { name: 'References', value: reply.references }] };
  const files: any = { value: [] }, reads: any[] = [];
  (h.service as any).loadConnection = async () => ({ token: {}, connection: { accountEmail: 'sender@example.test' } });
  (h.service as any).graphGet = async (url: string, _token: string, headers: unknown, maxBytes: number) => {
    reads.push({ url, headers, maxBytes });
    return url.includes('/attachments?') ? files : url.startsWith('/me/messages/original-immutable?') ? original : draft;
  };
  return { ...h, input: { ...INPUT, reply }, original, draft, files, reads };
}

test.each(['version','immutable-id','reply-to','draft','delegated'])('changed original %s prevents any mutation', async kind => {
  const h = makeReplyService(), original: any = h.original;
  if (kind === 'version') original.changeKey = 'new-version';
  if (kind === 'immutable-id') original.id = 'default-or-other';
  if (kind === 'reply-to') delete original.replyTo;
  if (kind === 'draft') original.isDraft = true;
  if (kind === 'delegated') original.sender.emailAddress.address = 'delegate@example.test';
  await expect(h.service.sendMail(ctx, 'conn-1', h.input)).rejects.toThrow();
  expect(h.calls).toEqual([]);
});

test.each(['body','recipient','subject','correlation','extra-file','paged-files','from','malformed-type','reference'])('draft %s drift never reaches send', async kind => {
  const h = makeReplyService();
  if (kind === 'body') h.draft.body.content += '<p>Unreviewed original</p>';
  if (kind === 'recipient') h.draft.toRecipients[0].emailAddress.address = 'other@example.test';
  if (kind === 'subject') h.draft.subject = 'Re: changed';
  if (kind === 'correlation') h.draft.internetMessageHeaders.shift();
  if (kind === 'extra-file') h.files.value.push({ name: 'inherited' });
  if (kind === 'paged-files') h.files['@odata.nextLink'] = 'unread-page';
  if (kind === 'from') h.draft.from.emailAddress.address = 'other@example.test';
  if (kind === 'malformed-type') h.draft.body.contentType = 17;
  if (kind === 'reference') h.draft.internetMessageHeaders[2].value = '<other@example.test>';
  await expect(h.service.sendMail(ctx, 'conn-1', h.input)).rejects.toThrow();
  expect(h.calls.map(c => c.url)).toEqual(['/me/messages/original-immutable/createReply']);
});

test.each([false, true])('only exact separately authorized outgoing file bytes send, changed=%s', async changed => {
  const h = makeReplyService();
  const attachment = { name: 'reviewed.pdf', contentType: 'application/pdf', contentBytes: Buffer.from('Reviewed bytes').toString('base64') };
  const input = { ...h.input, attachments: [attachment] };
  h.draft.hasAttachments = true;
  h.files.value = [{ '@odata.type': '#microsoft.graph.fileAttachment', isInline: false, ...attachment,
    ...(changed ? { contentBytes: Buffer.from('Other bytes').toString('base64') } : {}) }];
  if (changed) await expect(h.service.sendMail(ctx, 'conn-1', input)).rejects.toThrow();
  else {
    const result = await h.service.sendMail(ctx, 'conn-1', input);
    expect(result).toMatchObject({ providerConversationId: 'reply-conversation', providerImmutableMessageId: 'draft-1' });
    expect(h.reads.map(r => r.maxBytes)).toEqual([65536, 262144, 5_500_000]);
    expect(h.reads.every(r => r.headers.Prefer.includes('IdType="ImmutableId"'))).toBe(true);
  }
  expect(h.calls).toHaveLength(changed ? 1 : 2);
});

test.each(['source-gone', 'draft-unreadable', 'create-timeout', 'send-503'])('%s never retries native creation or send', async phase => {
  const h = makeReplyService();
  const originalRead = (h.service as any).graphGet;
  if (phase === 'source-gone' || phase === 'draft-unreadable') (h.service as any).graphGet = async (...args: any[]) => {
    if (phase === 'source-gone' || !args[0].includes('original-immutable')) throw new GraphHttpError('Unavailable', 404);
    return originalRead(...args);
  };
  if (phase === 'create-timeout') (h.service as any).graphPost = async (url: string) => { h.calls.push({ url, body: null }); throw new TypeError('fetch failed'); };
  if (phase === 'send-503') (h.service as any).graphPostNoContent = async (url: string) => { h.calls.push({ url, body: null }); throw new GraphHttpError('Unavailable', 503); };
  let failure: unknown;
  try { await h.service.sendMail(ctx, 'conn-1', h.input); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect(isDefiniteMailSendRejection(failure)).toBe(phase === 'source-gone');
  expect(h.calls).toHaveLength(phase === 'source-gone' ? 0 : phase === 'send-503' ? 2 : 1);
});

test('actual Graph transport emits plain standard-base64 MIME and an empty sole send with immutable Prefer', async () => {
  const h = makeReplyService(), transport = MicrosoftGraphSyncService.prototype as any, requests: any[] = [];
  (h.service as any).graphPost = transport.graphPost; (h.service as any).graphPostNoContent = transport.graphPostNoContent;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: any) => {
    requests.push({ url, init });
    return requests.length === 1 ? new Response(JSON.stringify({ id: 'draft-1', conversationId: 'reply-conversation' }), { status: 201 }) : new Response(null, { status: 202 });
  }) as typeof fetch;
  try { await h.service.sendMail(ctx, 'conn-1', h.input); } finally { globalThis.fetch = previous; }
  expect(requests).toHaveLength(2);
  expect(requests[0].init.headers).toMatchObject({ 'Content-Type': 'text/plain', Prefer: 'IdType="ImmutableId"' });
  expect(requests[0].init.body).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  expect(Buffer.from(requests[0].init.body, 'base64').toString()).toContain(`X-Capiro-Delivery-Id: ${CORRELATION}\r\n`);
  expect(requests[1].init.body).toBeUndefined();
  expect(requests[1].init.headers.Prefer).toBe('IdType="ImmutableId"');
});

test('bounded reply read refuses oversized bytes and never mutates or retries', async () => {
  const service = Object.create(MicrosoftGraphSyncService.prototype) as any, previous = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (async () => { reads++; return new Response(JSON.stringify({ value: 'é'.repeat(80) })); }) as typeof fetch;
  try { await expect(service.graphGet('/me/messages/synthetic', 'synthetic', {}, 100)).rejects.toThrow('byte limit'); }
  finally { globalThis.fetch = previous; }
  expect(reads).toBe(1);
});

test('Outlook receives every To/Cc/Bcc recipient and both exact attachments', async () => {
  const h = makeService({});
  const attachments = [
    {
      name: 'brief.pdf',
      contentType: 'application/pdf',
      contentBytes: Buffer.from('%PDF-1.7\nbrief').toString('base64'),
    },
    {
      name: 'contacts.csv',
      contentType: 'text/csv',
      contentBytes: Buffer.from('name,email\r\nA,a@example.test').toString('base64'),
    },
  ];
  await h.service.sendMail(ctx, 'conn-1', {
    ...INPUT,
    toRecipients: ['a@example.test', 'b@example.test', 'c@example.test'].map((email) => ({
      email,
    })),
    ccRecipients: [{ email: 'copy@example.test' }],
    bccRecipients: [{ email: 'private@example.test' }],
    attachments,
  });
  expect(h.calls[0]!.body).toMatchObject({
    toRecipients: ['a@example.test', 'b@example.test', 'c@example.test'].map((address) => ({
      emailAddress: { address },
    })),
    ccRecipients: [{ emailAddress: { address: 'copy@example.test' } }],
    bccRecipients: [{ emailAddress: { address: 'private@example.test' } }],
    attachments: attachments.map((attachment) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      ...attachment,
    })),
  });
  expect(h.calls.map((call) => call.url)).toEqual(['/me/messages', '/me/messages/draft-1/send']);
});

interface Call {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
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
  patch.graphPost = async (url: string, _t: string, body: unknown, headers: Record<string, string>) => {
    calls.push({ url, body, headers });
    if (opts.draftThrows) throw opts.draftThrows;
    return opts.draftResponse ?? { id: 'draft-1', internetMessageId: '<abc@contoso.com>' };
  };
  patch.graphPostNoContent = async (url: string, _t: string, body: unknown, headers: Record<string, string>) => {
    calls.push({ url, body, headers });
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
  test('a plain HttpException with no known status is NOT ambiguous (unchanged, backward-compatible default)', () => {
    expect(
      isAmbiguousGraphSendFailure(new ServiceUnavailableException('Graph 400 bad request')),
    ).toBe(false);
  });

  test('transport failures ARE ambiguous', () => {
    expect(isAmbiguousGraphSendFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isAmbiguousGraphSendFailure(new Error('socket hang up'))).toBe(true);
    expect(isAmbiguousGraphSendFailure(new Error('read ECONNRESET'))).toBe(true);
    expect(isAmbiguousGraphSendFailure(new Error('request timeout'))).toBe(true);
  });

  // §g5 / Open Decision 6.3 — graphFetch now carries the real status through
  // GraphHttpError. A 4xx means Graph answered "no" to the request itself:
  // known, plain failure. A 5xx is Graph's OWN failure while handling the
  // request — it does not guarantee nothing was accepted, so it is treated
  // the same as a transport-level ambiguity, not a confirmed rejection.
  test.each([500, 502, 503, 504])('a GraphHttpError carrying status %i IS ambiguous', (status) => {
    expect(
      isAmbiguousGraphSendFailure(new GraphHttpError(`Graph failed (${status})`, status)),
    ).toBe(true);
  });

  test.each([400, 401, 403, 404, 429])(
    'a GraphHttpError carrying status %i is a KNOWN failure',
    (status) => {
      expect(
        isAmbiguousGraphSendFailure(new GraphHttpError(`Graph failed (${status})`, status)),
      ).toBe(false);
    },
  );
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
      providerImmutableMessageId: 'draft-1',
      providerInternetMessageId: '<abc@contoso.com>',
      correlationId: CORRELATION,
    });
    expect(h.calls.map((call) => call.headers)).toEqual([
      { Prefer: 'IdType="ImmutableId"' }, { Prefer: 'IdType="ImmutableId"' },
    ]);
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
    expect(err.providerImmutableMessageId).toBe('draft-1');
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
