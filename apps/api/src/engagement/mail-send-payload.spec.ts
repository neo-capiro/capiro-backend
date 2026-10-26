import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { EngagementProvider } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementMailSender, type EngagementSendMailInput } from './mail-sender.service.js';
import { AmbiguousMailSendError, isDefiniteMailSendRejection } from './mail-send-result.js';
import { GmailSendService, buildGmailRawMessage } from './google/gmail-send.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';

const GRAPH_LIMIT = 4_000_000;
const GMAIL_LIMIT = 36_700_160;
const ctx = { tenantId: 'synthetic-tenant', userId: 'synthetic-actor' } as TenantContext;
const base: EngagementSendMailInput = {
  subject: 'Review',
  body: '<p>Update</p><footer>Reviewed signature</footer>',
  bodyContentType: 'HTML',
  toRecipients: [{ email: 'to@example.test' }],
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function attachment(bytes: number, name = 'report.pdf') {
  return {
    name,
    contentType: 'application/pdf',
    contentBytes: Buffer.alloc(bytes, 97).toString('base64'),
  };
}

function harness() {
  const graphRequests: Array<{ path: string; body?: unknown }> = [];
  const graph = Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService;
  const graphPorts = graph as unknown as Record<string, unknown>;
  const graphAuth = jest.fn(async () => {});
  graphPorts.assertConnectionAccess = graphAuth;
  graphPorts.loadConnection = async () => ({ token: {} });
  graphPorts.getValidAccessToken = async () => 'synthetic-token';
  graphPorts.graphPost = async (path: string, _token: string, body: unknown) => {
    graphRequests.push({ path, body });
    return { id: 'synthetic-draft', conversationId: 'synthetic-thread' };
  };
  graphPorts.graphPostNoContent = async (path: string) => {
    graphRequests.push({ path });
  };
  const gmailAuth = jest.fn(async () => ({
    connection: { createdByUserId: ctx.userId },
    token: {},
  }));
  const gmail = new GmailSendService({
    loadConnection: gmailAuth,
    getValidAccessToken: async () => 'synthetic-token',
  } as never);
  const fetcher = jest.fn(
    async (_url: unknown, _init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'synthetic-message', threadId: 'synthetic-thread' }),
      }) as Response,
  );
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const sender = new EngagementMailSender(graph, gmail, {
    assertExternalAction: () => {},
  } as never);
  const send = (provider: EngagementProvider, input: EngagementSendMailInput) =>
    sender.sendMail(ctx, { id: 'synthetic-mailbox', provider }, input);
  return { graph, graphAuth, graphRequests, gmailAuth, fetcher, send };
}

async function expectSizeRefusal(
  h: ReturnType<typeof harness>,
  provider: EngagementProvider,
  input: EngagementSendMailInput,
) {
  let failure: unknown;
  try {
    await h.send(provider, input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BadRequestException);
  expect(isDefiniteMailSendRejection(failure)).toBe(true);
  expect((failure as BadRequestException).getResponse()).toMatchObject({
    code: 'MAIL_PAYLOAD_TOO_LARGE',
  });
  expect(h.graphRequests).toHaveLength(0);
  expect(h.graphAuth).not.toHaveBeenCalled();
  expect(h.gmailAuth).not.toHaveBeenCalled();
  expect(h.fetcher).not.toHaveBeenCalled();
}

// Calibrate from the real Graph serializer through stubbed ports, not a second
// implementation of its JSON shape or the preflight's own size calculation.
async function graphBoundary(h: ReturnType<typeof harness>, delta: number) {
  await h.graph.sendMail(ctx, 'synthetic-mailbox', { ...base, body: '' });
  const emptyBytes = Buffer.byteLength(JSON.stringify(h.graphRequests[0]!.body), 'utf8');
  h.graphRequests.length = 0;
  h.graphAuth.mockClear();
  return { ...base, body: 'a'.repeat(GRAPH_LIMIT - emptyBytes + delta) };
}

function gmailBoundary(delta: number) {
  const input = { ...base, subject: '', attachments: [attachment(1024, 'Résumé 📎.pdf')] };
  const emptyMimeBytes = Buffer.from(buildGmailRawMessage(input), 'base64url').byteLength;
  // JSON {raw:""} costs ten bytes. The MIME builder's random boundary has a
  // fixed ASCII length; padding an ASCII subject changes only these bytes.
  const mimeBudget = Math.floor(((GMAIL_LIMIT - 10) * 3) / 4);
  return { ...input, subject: 'a'.repeat(mimeBudget - emptyMimeBytes + delta) };
}

describe('ML-21 aggregate encoded request preflight', () => {
  test('the Graph wire shape retains all recipients, attachments, signature and safe correlation', async () => {
    const h = harness();
    const input = {
      ...base,
      subject: 'Résumé "brief"',
      body: '<p>你好</p><footer>Signature é</footer>',
      toRecipients: [{ email: 'to@example.test', name: '名' }],
      ccRecipients: [{ email: 'copy@example.test', name: null }],
      bccRecipients: [{ email: 'hidden@example.test', name: '' }],
      attachments: [attachment(6, 'Résumé 📎.pdf'), attachment(9, 'second.pdf')],
      correlationId: 'synthetic-correlation',
    };
    await h.send(EngagementProvider.microsoft_365, input);
    expect(h.graphRequests).toEqual([
      {
        path: '/me/messages',
        body: {
          subject: input.subject,
          body: { contentType: 'HTML', content: input.body },
          toRecipients: [{ emailAddress: { address: 'to@example.test', name: '名' } }],
          ccRecipients: [{ emailAddress: { address: 'copy@example.test' } }],
          bccRecipients: [{ emailAddress: { address: 'hidden@example.test' } }],
          attachments: input.attachments.map((file) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            ...file,
          })),
          internetMessageHeaders: [
            { name: 'X-Capiro-Delivery-Id', value: 'synthetic-correlation' },
          ],
        },
      },
      { path: '/me/messages/synthetic-draft/send' },
    ]);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  test('Graph rejects combined individually valid files before draft creation or token work', async () => {
    const h = harness();
    await expectSizeRefusal(h, EngagementProvider.microsoft_365, {
      ...base,
      body: '<p>你好</p><footer>Signature é</footer>',
      attachments: [attachment(1_500_000, 'Résumé 📎.pdf'), attachment(1_500_000, 'second.pdf')],
    });
  });

  test('Gmail accepts the same multi-file envelope above Graph limit with complete MIME content', async () => {
    const h = harness();
    const input = {
      ...base,
      attachments: [attachment(1_500_000), attachment(1_500_000, 'second.pdf')],
    };
    await h.send(EngagementProvider.google_workspace, input);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const body = String(h.fetcher.mock.calls[0]![1]!.body);
    expect(Buffer.byteLength(body)).toBeGreaterThan(GRAPH_LIMIT);
    const mime = Buffer.from(JSON.parse(body).raw, 'base64url').toString('utf8');
    expect(mime).toContain('filename="report.pdf"');
    expect(mime).toContain('filename="second.pdf"');
    expect(mime).toContain(Buffer.from(input.body).toString('base64'));
    expect(h.graphRequests).toHaveLength(0);
  });

  test('Graph accepts exactly its encoded JSON budget', async () => {
    const h = harness();
    await h.send(EngagementProvider.microsoft_365, await graphBoundary(h, 0));
    expect(Buffer.byteLength(JSON.stringify(h.graphRequests[0]!.body), 'utf8')).toBe(GRAPH_LIMIT);
    expect(h.graphRequests).toHaveLength(2);
  });

  test('Graph rejects one byte beyond its encoded JSON budget', async () => {
    const h = harness();
    await expectSizeRefusal(h, EngagementProvider.microsoft_365, await graphBoundary(h, 1));
  });

  test('Graph counts Unicode signature bytes rather than JavaScript character count', async () => {
    const h = harness();
    const input = await graphBoundary(h, -1);
    await expectSizeRefusal(h, EngagementProvider.microsoft_365, {
      ...input,
      body: `${input.body}é`,
    });
  });

  test('Gmail accepts exactly its conservative encoded request-envelope budget', async () => {
    const h = harness();
    await h.send(EngagementProvider.google_workspace, gmailBoundary(0));
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(String(h.fetcher.mock.calls[0]![1]!.body), 'utf8')).toBe(GMAIL_LIMIT);
  });

  test('Gmail rejects envelope overflow even while decoded MIME remains under the media limit', async () => {
    const h = harness();
    const input = gmailBoundary(1);
    const raw = buildGmailRawMessage(input);
    expect(Buffer.from(raw, 'base64url').byteLength).toBeLessThan(GMAIL_LIMIT);
    expect(Buffer.byteLength(JSON.stringify({ raw }), 'utf8')).toBeGreaterThan(GMAIL_LIMIT);
    await expectSizeRefusal(h, EngagementProvider.google_workspace, input);
  });

  test('Gmail rejects the aggregate of repeated individually valid attachment entries', async () => {
    const h = harness();
    const file = attachment(2_500_000, 'Résumé 📎.pdf');
    await expectSizeRefusal(h, EngagementProvider.google_workspace, {
      ...base,
      attachments: Array(9).fill(file),
    });
  });

  test('a dispatched ambiguous outcome is preserved unchanged without retry', async () => {
    const unknown = new AmbiguousMailSendError(
      'Synthetic lost acknowledgement',
      'synthetic-correlation',
    );
    const dispatch = jest.fn(async () => {
      throw unknown;
    });
    const sender = new EngagementMailSender(
      { sendMail: dispatch } as never,
      {} as never,
      { assertExternalAction: () => {} } as never,
    );
    await expect(
      sender.sendMail(
        ctx,
        { id: 'synthetic-mailbox', provider: EngagementProvider.microsoft_365 },
        base,
      ),
    ).rejects.toBe(unknown);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(isDefiniteMailSendRejection(unknown)).toBe(false);
  });
});
