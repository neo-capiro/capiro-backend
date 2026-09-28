import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';
import { currentOwnerResultAuthorizesReplay } from './meri-research-replay-authorization.js';

// This mail delegation fixture never instantiates unrelated program-element
// dependencies (whose package subpath is not resolved by ts-jest's CJS mode).
jest.mock('../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: class {},
}));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));

const ctx = { tenantId: 'tenant', userId: 'owner' } as TenantContext;
function service(result: unknown) {
  const searchMailMessages = jest.fn().mockResolvedValue(result);
  const tools = Object.create(MeriToolsService.prototype) as any;
  tools.engagement = { searchMailMessages };
  return { tools, searchMailMessages };
}

describe('Meri canonical mailbox tools', () => {
  it('emits server body evidence that the durable owner adapter accepts unchanged', async () => {
    const threadId = '11111111-1111-4111-8111-111111111111';
    const messageId = '22222222-2222-4222-8222-222222222222';
    const { tools } = service({});
    tools.engagement.getMailThread = jest.fn().mockResolvedValue({
      id: threadId,
      subject: 'Canonical source',
      clientId: '33333333-3333-4333-8333-333333333333',
      connectionId: '44444444-4444-4444-8444-444444444444',
      connectionEmail: 'owner@example.com',
      connectionStatus: 'connected',
      updatedAt: new Date('2026-09-28T00:00:00.000Z'),
      messages: [{
        id: messageId,
        connectionId: '44444444-4444-4444-8444-444444444444',
        subject: 'Canonical source',
        bodyText: 'Exact complete source body.',
        metadata: { bodyCompleteness: 'full' },
        fromEmail: 'sender@example.com',
        fromName: 'Sender',
        toRecipients: [],
        ccRecipients: [],
        updatedAt: new Date('2026-09-28T00:01:00.000Z'),
      }],
    });

    const result = await tools.getEmailThread(ctx, { threadId });

    expect(currentOwnerResultAuthorizesReplay('get_email_thread', result, structuredClone(result)))
      .toBe(true);
    expect(result.messages[0].sourceProof.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(tools.engagement.getMailThread).toHaveBeenCalledWith(ctx, threadId, undefined);
  });

  it('reads stored details beyond the inventory preview through the canonical authorized thread reader', async () => {
    const threadId = '11111111-1111-4111-8111-111111111111';
    const messageId = '22222222-2222-4222-8222-222222222222';
    const { tools } = service({});
    const body = 'Background. '.repeat(100) + 'Please send the draft by Friday.';
    tools.engagement.getMailThread = jest.fn().mockResolvedValue({
      id: threadId,
      subject: 'Action needed',
      clientId: null,
      connectionId: 'mailbox-1',
      connectionEmail: 'owner@example.com',
      connectionStatus: 'connected',
      updatedAt: new Date('2026-09-28T00:00:00.000Z'),
      messages: [
        {
          id: messageId,
          subject: 'Action needed',
          bodyText: body,
          connectionId: 'mailbox-1',
          updatedAt: new Date('2026-09-28T00:01:00.000Z'),
          metadata: { bodyCompleteness: 'full' },
          fromEmail: 'sender@example.com',
        },
      ],
    });
    const first = await tools.getEmailThread(ctx, { threadId, maxCharacters: 600 });
    expect(tools.engagement.getMailThread).toHaveBeenCalledWith(ctx, threadId, undefined);
    expect(first.messages[0]).toMatchObject({
      bodyTruncated: true,
      nextBodyOffset: 600,
      bodyCompleteness: 'full',
    });
    const rest = await tools.getEmailThread(ctx, {
      threadId,
      messageId,
      bodyOffset: 600,
      maxCharacters: 6000,
    });
    expect(first.messages[0].bodyText + rest.messages[0].bodyText).toBe(body);
    expect(rest.messages[0].bodyText).toContain('draft by Friday');
    expect(rest.messages[0].nextBodyOffset).toBeNull();
  });

  it('preserves canonical authorization failures when reading a mail body', async () => {
    const { tools } = service({});
    tools.engagement.getMailThread = jest
      .fn()
      .mockRejectedValue(new Error('Mail thread not found'));
    await expect(
      tools.getEmailThread(ctx, { threadId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toThrow('Mail thread not found');
  });

  it('enforces an explicit client scope while preserving unscoped personal mail', async () => {
    const threadId = '11111111-1111-4111-8111-111111111111';
    const clientA = '33333333-3333-4333-8333-333333333333';
    const clientB = '55555555-5555-4555-8555-555555555555';
    const { tools } = service({});
    tools.engagement.getMailThread = jest.fn().mockResolvedValue({
      id: threadId,
      subject: 'Scoped source',
      clientId: clientA,
      connectionId: 'mailbox-1',
      connectionEmail: 'owner@example.test',
      connectionStatus: 'connected',
      updatedAt: new Date('2026-09-28T00:00:00.000Z'),
      messages: [],
    });

    await expect(tools.getEmailThread(ctx, { threadId, clientId: clientA })).resolves.toMatchObject({
      sourceProof: { clientId: clientA },
    });
    expect(tools.engagement.getMailThread).toHaveBeenLastCalledWith(ctx, threadId, clientA);
    await expect(tools.getEmailThread(ctx, { threadId, clientId: clientB })).rejects.toThrow(
      'Mail thread not found',
    );
    await expect(tools.getEmailThread(ctx, { threadId })).resolves.toMatchObject({
      sourceProof: { clientId: clientA },
    });
    expect(tools.engagement.getMailThread).toHaveBeenLastCalledWith(ctx, threadId, undefined);
  });

  it('requires an exact message for body continuation and rejects unbounded reads', async () => {
    const { tools } = service({});
    tools.engagement.getMailThread = jest.fn();
    const threadId = '11111111-1111-4111-8111-111111111111';
    expect(await tools.getEmailThread(ctx, { threadId, bodyOffset: 600 })).toHaveProperty('error');
    expect(await tools.getEmailThread(ctx, { threadId, maxCharacters: 7000 })).toHaveProperty(
      'error',
    );
    expect(tools.engagement.getMailThread).not.toHaveBeenCalled();
  });

  it('delegates date-only inbox search without manufacturing a keyword', async () => {
    const result = { messages: [], searchedMailboxes: [], hasMore: false };
    const { tools, searchMailMessages } = service(result);
    const input = { withinDays: 14, folder: 'inbox', limit: 50 };
    expect(await tools.searchEmails(ctx, input)).toBe(result);
    expect(searchMailMessages).toHaveBeenCalledWith(ctx, input);
  });

  it('lists the same bounded message page through canonical engagement and preserves thread citation IDs', async () => {
    const result = {
      totalMatches: 60,
      returned: 1,
      hasMore: true,
      nextOffset: 1,
      asOf: '2026-09-07T12:00:00.000Z',
      searchedMailboxes: [{ status: 'connected' }],
      messages: [
        {
          id: 'message',
          threadId: 'thread',
          subject: 'Meeting request',
          from: { email: 'sender@example.com', name: 'Sender' },
          preview: 'Thursday works',
          receivedAt: new Date('2026-09-06'),
          sentAt: null,
          client: null,
        },
      ],
    };
    const { tools, searchMailMessages } = service(result);
    const input = { withinDays: 14, folder: 'inbox' };
    const out = await tools.listEmails(ctx, input);
    expect(searchMailMessages).toHaveBeenCalledWith(ctx, input, {
      allowUnfiltered: true,
      defaultLimit: 15,
    });
    expect(out).toMatchObject({
      totalMatches: 60,
      nextOffset: 1,
      hasMore: true,
      count: 1,
      threads: [{ id: 'thread', messages: [{ id: 'message', bodyText: 'Thursday works' }] }],
    });
    expect(out.searchedMailboxes).toEqual(result.searchedMailboxes);
  });

  it('passes through canonical invalid-scope errors without claiming an empty inbox', async () => {
    const { tools } = service({ error: 'folder must be inbox, sent, or all.' });
    expect(await tools.listEmails(ctx, { folder: 'trash' })).toEqual({
      error: 'folder must be inbox, sent, or all.',
    });
  });
});
