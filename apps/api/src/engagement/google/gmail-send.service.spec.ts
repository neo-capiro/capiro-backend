// Engagement Phase 0 (plan §3.e2) — Gmail returns its message resource.
//
// Change-controlled file: these tests exist to prove the change is narrow. What
// must be TRUE afterwards: the message/thread ids are surfaced, the correlation
// header is present and injection-safe, a success-without-id is AMBIGUOUS (not a
// retryable failure), and the pre-existing header/MIME guards still hold.

import { describe, expect, test } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  GmailSendService,
  buildGmailRawMessage,
  sanitizeCorrelationId,
} from './gmail-send.service.js';
import { AmbiguousMailSendError } from '../mail-send-result.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

const INPUT = {
  subject: 'Funding update',
  body: '<p>Hello</p>',
  bodyContentType: 'HTML' as const,
  toRecipients: [{ email: 'a@x.com', name: 'A' }],
  correlationId: 'b3f1c2d4-1111-4222-8333-444455556666',
};

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

function makeService(fetchImpl: () => Promise<Response>, owner = 'u1') {
  const service = Object.create(GmailSendService.prototype) as GmailSendService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {} };
  patch.googleToken = {
    loadConnection: async () => ({
      connection: { createdByUserId: owner },
      token: {},
    }),
    getValidAccessToken: async () => 'access-token',
  };
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  return { service, restore: () => (globalThis.fetch = original) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('sanitizeCorrelationId', () => {
  test('a UUID passes through unchanged', () => {
    expect(sanitizeCorrelationId(INPUT.correlationId)).toBe(INPUT.correlationId);
  });

  test('a header-injection attempt is DROPPED, not escaped', () => {
    expect(sanitizeCorrelationId('abc\r\nBcc: victim@x.com')).toBeNull();
    expect(sanitizeCorrelationId('abc\nSubject: hijacked')).toBeNull();
    expect(sanitizeCorrelationId('has spaces')).toBeNull();
    expect(sanitizeCorrelationId('x'.repeat(200))).toBeNull();
    expect(sanitizeCorrelationId(undefined)).toBeNull();
  });
});

describe('buildGmailRawMessage — correlation header', () => {
  test('stamps exactly one X-Capiro-Delivery-Id header', () => {
    const mime = decodeRaw(buildGmailRawMessage(INPUT));
    expect(mime).toContain(`X-Capiro-Delivery-Id: ${INPUT.correlationId}`);
    expect(mime.match(/X-Capiro-Delivery-Id/g)).toHaveLength(1);
  });

  test('omits the header entirely when there is no correlation id', () => {
    const mime = decodeRaw(buildGmailRawMessage({ ...INPUT, correlationId: undefined }));
    expect(mime).not.toContain('X-Capiro-Delivery-Id');
  });

  test('a malicious correlation id cannot inject a header (existing CR/LF guard holds)', () => {
    const mime = decodeRaw(
      buildGmailRawMessage({ ...INPUT, correlationId: 'abc\r\nBcc: victim@x.com' }),
    );
    expect(mime).not.toContain('victim@x.com');
    expect(mime).not.toContain('X-Capiro-Delivery-Id');
  });

  test('pre-existing behaviour is intact: To/Subject/HTML content type, no From', () => {
    const mime = decodeRaw(buildGmailRawMessage(INPUT));
    expect(mime).toContain('To: A <a@x.com>');
    expect(mime).toContain('Subject: Funding update');
    expect(mime).toContain('text/html; charset="UTF-8"');
    expect(mime).not.toMatch(/^From:/m);
  });

  test('subject CR/LF injection is still collapsed to one header line (regression guard)', () => {
    const mime = decodeRaw(
      buildGmailRawMessage({ ...INPUT, subject: 'Hi\r\nBcc: victim@x.com' }),
    );
    // The existing guard collapses CR/LF to a SPACE, so the smuggled text stays
    // inside the Subject VALUE and no second header is created. Assert on the
    // structure (no line begins with Bcc:), not on the text being absent.
    expect(mime).toContain('Subject: Hi Bcc: victim@x.com');
    expect(mime).not.toMatch(/^Bcc:/m);
    // To, Subject, MIME-Version, X-Capiro-Delivery-Id, Content-Type,
    // Content-Transfer-Encoding — six lines, i.e. no extra header was smuggled in.
    expect(mime.split('\r\n\r\n')[0]!.split('\r\n')).toHaveLength(6);
  });
});

describe('sendMail — result contract', () => {
  test('returns the Gmail message + thread ids and the correlation id', async () => {
    const h = makeService(async () => jsonResponse({ id: 'gm-123', threadId: 'th-456' }));
    try {
      const out = await h.service.sendMail(ctx, 'conn-1', INPUT);
      expect(out).toEqual({
        ok: true,
        provider: 'gmail',
        providerMessageId: 'gm-123',
        providerThreadId: 'th-456',
        correlationId: INPUT.correlationId,
      });
    } finally {
      h.restore();
    }
  });

  test('a missing threadId is simply omitted', async () => {
    const h = makeService(async () => jsonResponse({ id: 'gm-123' }));
    try {
      const out = await h.service.sendMail(ctx, 'conn-1', INPUT);
      expect(out.providerMessageId).toBe('gm-123');
      expect(out.providerThreadId).toBeUndefined();
    } finally {
      h.restore();
    }
  });

  test('HTTP 200 WITHOUT an id is AMBIGUOUS — never a retryable failure', async () => {
    const h = makeService(async () => jsonResponse({ threadId: 'th-1' }));
    try {
      await expect(h.service.sendMail(ctx, 'conn-1', INPUT)).rejects.toBeInstanceOf(
        AmbiguousMailSendError,
      );
    } finally {
      h.restore();
    }
  });

  test('an unreadable success body is AMBIGUOUS (the mail may already be gone)', async () => {
    const h = makeService(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('not json');
          },
          text: async () => '',
        }) as unknown as Response,
    );
    try {
      await expect(h.service.sendMail(ctx, 'conn-1', INPUT)).rejects.toBeInstanceOf(
        AmbiguousMailSendError,
      );
    } finally {
      h.restore();
    }
  });

  test('an explicit 403 insufficient-scope still asks the user to reconnect (unchanged)', async () => {
    const h = makeService(async () =>
      jsonResponse({ error: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }, 403),
    );
    try {
      await expect(h.service.sendMail(ctx, 'conn-1', INPUT)).rejects.toThrow(/Reconnect Google/i);
    } finally {
      h.restore();
    }
  });

  test('sending through a mailbox the caller does not own is still forbidden (unchanged)', async () => {
    const h = makeService(async () => jsonResponse({ id: 'gm-1' }), 'someone-else');
    try {
      await expect(h.service.sendMail(ctx, 'conn-1', INPUT)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    } finally {
      h.restore();
    }
  });

  test('Bcc never appears in the returned metadata', async () => {
    const h = makeService(async () => jsonResponse({ id: 'gm-1', threadId: 't-1' }));
    try {
      const out = await h.service.sendMail(ctx, 'conn-1', {
        ...INPUT,
        bccRecipients: [{ email: 'secret@x.com' }],
      });
      expect(JSON.stringify(out)).not.toContain('secret@x.com');
    } finally {
      h.restore();
    }
  });
});
