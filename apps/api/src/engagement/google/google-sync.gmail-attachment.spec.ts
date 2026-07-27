// New (remaining-items plan §3.e3) — gmailGet must hydrate an
// attachment-backed preferred body part via a SECOND request to the Gmail
// attachments endpoint, bounded by GMAIL_BODY_ATTACHMENT_MAX_BYTES, and must
// degrade to the unhydrated message (persistence's snippet fallback) rather
// than fail the whole mailbox sync on an oversized or gone attachment.

import { describe, expect, test, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { GoogleSyncService } from './google-sync.service.js';

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function makeService(fetchImpl: (url: string) => Promise<Response>) {
  const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: jest.fn(), error: jest.fn() };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => fetchImpl(url)) as unknown as typeof fetch;
  return { service, patch, restore: () => (globalThis.fetch = original) };
}

function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

async function callGmailGet(service: GoogleSyncService, id: string): Promise<{
  id?: string;
  payload?: { body?: { data?: string; attachmentId?: string; size?: number } };
}> {
  return (
    service as unknown as {
      gmailGet: (token: string, id: string) => Promise<{
        id?: string;
        payload?: { body?: { data?: string; attachmentId?: string; size?: number } };
      }>;
    }
  ).gmailGet('token', id);
}

// A factory, not a shared constant: gmailGet's hydration mutates
// payload.body.data on the object it's handed (by design -- that IS the
// hydration), so a fixture reused by reference across tests would leak one
// test's mutation into the next.
function attachmentMessage() {
  return {
    id: 'm1',
    threadId: 't1',
    payload: { mimeType: 'text/plain', body: { attachmentId: 'att-1', size: 42 } },
  };
}

describe('GoogleSyncService.gmailGet — attachment-backed body hydration', () => {
  test('performs a second request to the attachments endpoint and inserts the data into the intended part', async () => {
    const urls: string[] = [];
    const { service, restore } = makeService(async (url) => {
      urls.push(url);
      if (url.includes('/attachments/')) {
        return jsonResponse({ data: b64url('Hydrated body text'), size: 19 }, 200);
      }
      return jsonResponse(attachmentMessage(), 200);
    });
    try {
      const message = await callGmailGet(service, 'm1');

      expect(urls).toHaveLength(2);
      expect(urls[1]).toContain('/messages/m1/attachments/att-1');
      expect(message.payload?.body?.data).toBe(b64url('Hydrated body text'));
    } finally {
      restore();
    }
  });

  test('a message with no attachment-backed part triggers only one fetch (nothing to hydrate)', async () => {
    const inlineMessage = {
      id: 'm3',
      payload: { mimeType: 'text/plain', body: { data: b64url('Already inline') } },
    };
    let fetchCount = 0;
    const { service, restore } = makeService(async () => {
      fetchCount += 1;
      return jsonResponse(inlineMessage, 200);
    });
    try {
      await callGmailGet(service, 'm3');
      expect(fetchCount).toBe(1);
    } finally {
      restore();
    }
  });

  test('an oversized body attachment is not fetched; the unhydrated message is returned', async () => {
    const oversized = {
      id: 'm2',
      threadId: 't1',
      payload: { mimeType: 'text/plain', body: { attachmentId: 'att-big', size: 2_000_000 } },
    };
    let attachmentFetchCount = 0;
    const { service, patch, restore } = makeService(async (url) => {
      if (url.includes('/attachments/')) {
        attachmentFetchCount += 1;
        return jsonResponse({ data: b64url('should never be fetched') }, 200);
      }
      return jsonResponse(oversized, 200);
    });
    try {
      const message = await callGmailGet(service, 'm2');

      expect(attachmentFetchCount).toBe(0);
      expect(message.payload?.body?.data).toBeUndefined();
      const warn = patch.logger as { warn: jest.Mock };
      expect(warn.warn).toHaveBeenCalledTimes(1);
      const warningText = String(warn.warn.mock.calls[0]?.[0]);
      expect(warningText).toContain('m2');
      expect(warningText).not.toContain('should never be fetched');
    } finally {
      restore();
    }
  });

  test('a 404/410 on the attachment falls back to the unhydrated message without failing the sync', async () => {
    const { service, patch, restore } = makeService(async (url) => {
      if (url.includes('/attachments/')) return jsonResponse({ error: 'gone' }, 410);
      return jsonResponse(attachmentMessage(), 200);
    });
    try {
      const message = await callGmailGet(service, 'm1');

      expect(message.payload?.body?.data).toBeUndefined();
      const warn = patch.logger as { warn: jest.Mock };
      expect(warn.warn).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('a 500 on the attachment propagates rather than silently falling back', async () => {
    const { service, restore } = makeService(async (url) => {
      if (url.includes('/attachments/')) return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse(attachmentMessage(), 200);
    });
    try {
      await expect(callGmailGet(service, 'm1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      restore();
    }
  });

  test('logs contain no body text or access-token material', async () => {
    const { service, patch, restore } = makeService(async (url) => {
      if (url.includes('/attachments/')) return jsonResponse({ error: 'gone' }, 404);
      return jsonResponse(attachmentMessage(), 200);
    });
    try {
      await callGmailGet(service, 'm1');
      const warn = patch.logger as { warn: jest.Mock };
      for (const call of warn.warn.mock.calls) {
        const text = String(call[0]);
        expect(text).not.toContain('token');
        expect(text).not.toContain('Hydrated body text');
      }
    } finally {
      restore();
    }
  });
});
