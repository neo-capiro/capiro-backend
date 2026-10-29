import { GmailSendService, buildGmailSendPayload } from './google/gmail-send.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { gmailReplyIdentity, graphReplyIdentity, prepareMailForward } from './single-mail-reply.js';
import {
  forwardBody,
  prepareForwardBody,
  gmailForwardBody,
  graphForwardBody,
  forwardedMessageHtml,
} from './mail-forward-source.js';
import { isDefiniteMailSendRejection } from './mail-send-result.js';

const body = forwardBody('Complete original <literal> & text 😀')!;
const original = {
  id: 'gmail-original',
  threadId: 'gmail-original-thread',
  labelIds: ['INBOX'],
  payload: {
    mimeType: 'text/plain',
    filename: '',
    headers: [
      { name: 'From', value: 'sender@example.test' },
      { name: 'Subject', value: 'Source subject' },
      { name: 'Message-ID', value: '<original@example.test>' },
    ],
    body: { data: Buffer.from(body.bodyText).toString('base64url') },
  },
};
const gmail = gmailReplyIdentity(original)!;
const box = (address: string) => ({ emailAddress: { address } });
const graphOriginal = {
  id: 'immutable-original',
  conversationId: 'source-conversation',
  changeKey: 'version',
  isDraft: false,
  subject: gmail.subject,
  from: box(gmail.fromEmail),
  sender: box(gmail.fromEmail),
  replyTo: [],
  internetMessageId: gmail.inReplyTo,
  internetMessageHeaders: [{ name: 'Message-ID', value: gmail.inReplyTo }],
  body: { contentType: 'text', content: body.bodyText },
  hasAttachments: false,
};
const graph = graphReplyIdentity(graphOriginal)!;
const input = {
  forward: { source: gmail, body },
  subject: 'Fwd: Source subject',
  toRecipients: [{ email: 'new@example.test' }],
  ccRecipients: [{ email: 'copy@example.test' }],
  bodyContentType: 'HTML' as const,
  body: `<p>Comment</p>${forwardedMessageHtml(gmail, body)}`,
  correlationId: '11111111-1111-4111-8111-111111111111',
};

describe('bounded native forward', () => {
  test('complete source text is escaped and distinct from editable comment and provider ancestry', () => {
    const source = {
      id: 'original',
      threadId: 'thread',
      connectionId: 'box',
      source: 'google',
      externalId: original.id,
      subject: gmail.subject,
      fromEmail: gmail.fromEmail,
      updatedAt: new Date('2026-10-27T00:00:00Z'),
      removedAt: null,
      bodyText: body.bodyText,
      hasAttachments: false,
      metadata: { bodyCompleteness: 'full' },
      raw: original,
    };
    const result = prepareMailForward(
      source,
      { id: 'thread', connectionId: 'box', source: 'google', externalId: original.threadId },
      {
        id: 'box',
        provider: 'google_workspace',
        status: 'connected',
        accountEmail: 'me@example.test',
      },
      [],
    )!;
    expect(result.context).toMatchObject({
      operation: 'forward',
      to: [],
      originalBodySha256: body.bodySha256,
      originalBodyText: body.bodyText,
    });
    expect(input.body).toContain('&lt;literal&gt; &amp; text');
    expect(buildGmailSendPayload(input)).not.toHaveProperty('threadId');
    const wire = Buffer.from(buildGmailSendPayload(input).raw, 'base64url').toString();
    expect(wire).toContain('Subject: Fwd: Source subject');
    expect(wire).not.toMatch(/In-Reply-To:|References:/);
  });
  test.each(['preview', 'html', 'files', 'multipart', 'content-id', 'over-limit'])(
    'forward refuses %s without partial original',
    (kind) => {
      const raw: any = structuredClone(original),
        metadata: any = { bodyCompleteness: 'full' };
      if (kind === 'preview') metadata.bodyCompleteness = 'preview';
      if (kind === 'html') raw.payload.mimeType = 'text/html';
      if (kind === 'multipart') raw.payload.parts = [{ mimeType: 'text/plain' }];
      if (kind === 'content-id')
        raw.payload.headers.push({ name: 'Content-ID', value: '<inline>' });
      expect(
        prepareForwardBody(
          {
            bodyText: kind === 'over-limit' ? 'x'.repeat(6001) : body.bodyText,
            hasAttachments: kind === 'files',
            metadata,
            raw,
          },
          false,
        ),
      ).toBeNull();
    },
  );
  test('fresh forward proof requires full Gmail bytes and complete empty Graph file list', () => {
    expect(gmailForwardBody(original)).toEqual(body);
    expect(
      gmailForwardBody({ ...original, payload: { ...original.payload, body: {} } }),
    ).toBeNull();
    expect(graphForwardBody(graphOriginal, { value: [] })).toEqual(body);
    expect(graphForwardBody(graphOriginal, { value: [{ id: 'inline' }] })).toBeNull();
    expect(graphForwardBody(graphOriginal, { value: [], '@odata.nextLink': 'more' })).toBeNull();
  });
  test.each([false, true])(
    'Gmail forward freshly verifies body before a new-message send, drift=%s',
    async (drift) => {
      const calls: string[] = [],
        previous = global.fetch;
      global.fetch = jest.fn(async (url, options) => {
        calls.push(`${options?.method} ${String(url)}`);
        if (options?.method === 'GET')
          return Response.json(
            drift
              ? {
                  ...original,
                  payload: {
                    ...original.payload,
                    body: { data: Buffer.from('changed').toString('base64url') },
                  },
                }
              : original,
          );
        return Response.json({ id: 'sent', threadId: 'new-conversation' });
      }) as typeof fetch;
      const service = new GmailSendService({
        loadConnection: async () => ({ connection: { createdByUserId: 'actor' }, token: {} }),
        getValidAccessToken: async () => 'synthetic',
      } as never);
      try {
        const pending = service.sendMail(
          { tenantId: 'tenant', userId: 'actor' } as never,
          'box',
          input,
        );
        if (drift) {
          const error = await pending.catch((error) => error);
          expect(isDefiniteMailSendRejection(error)).toBe(true);
          expect(calls).toHaveLength(1);
        } else {
          expect(await pending).toMatchObject({ providerThreadId: 'new-conversation' });
          expect(calls).toHaveLength(2);
        }
        expect(calls[0]).toContain('format=full');
      } finally {
        global.fetch = previous;
      }
    },
  );
  test.each(['accepted', 'incoming-file', 'draft-body'])(
    'Graph native forward %s preserves exact draft proof before sole send',
    async (mode) => {
      const service: any = Object.create(MicrosoftGraphSyncService.prototype),
        calls: string[] = [];
      const actual = { ...input, forward: { source: graph, body } };
      service.assertConnectionAccess = async () => {};
      service.loadConnection = async () => ({
        connection: { accountEmail: 'me@example.test' },
        token: {},
      });
      service.getValidAccessToken = async () => 'synthetic';
      service.graphGet = async (url: string) => {
        calls.push(`GET ${url}`);
        if (url.includes('immutable-original/attachments'))
          return { value: mode === 'incoming-file' ? [{ id: 'inline' }] : [] };
        if (url.includes('immutable-original?')) return graphOriginal;
        if (url.includes('/attachments?')) return { value: [] };
        return {
          id: 'draft',
          conversationId: 'new-conversation',
          isDraft: true,
          subject: actual.subject,
          body: { contentType: 'html', content: mode === 'draft-body' ? 'changed' : actual.body },
          from: box('me@example.test'),
          sender: box('me@example.test'),
          toRecipients: [box('new@example.test')],
          ccRecipients: [box('copy@example.test')],
          bccRecipients: [],
          replyTo: [],
          hasAttachments: false,
          internetMessageHeaders: [{ name: 'X-Capiro-Delivery-Id', value: input.correlationId }],
        };
      };
      service.graphPost = async (
        url: string,
        _token: string,
        payload: string,
        _headers: unknown,
        format: string,
      ) => {
        calls.push(`POST ${url}`);
        expect(url).toContain('/createForward');
        expect(format).toBe('mime');
        expect(Buffer.from(payload, 'base64').toString()).not.toContain('In-Reply-To:');
        return { id: 'draft', conversationId: 'new-conversation' };
      };
      service.graphPostNoContent = async (url: string) => {
        calls.push(`POST ${url}`);
      };
      const pending = service.sendMail(
        { tenantId: 'tenant', userId: 'actor' } as never,
        'box',
        actual,
      );
      if (mode === 'accepted') {
        expect(await pending).toMatchObject({ providerConversationId: 'new-conversation' });
        expect(calls.filter((c) => c.endsWith('/send'))).toHaveLength(1);
      } else {
        expect(isDefiniteMailSendRejection(await pending.catch((error: unknown) => error))).toBe(
          true,
        );
        expect(calls.some((c) => c.endsWith('/send'))).toBe(false);
      }
      if (mode === 'incoming-file') expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
    },
  );
});
