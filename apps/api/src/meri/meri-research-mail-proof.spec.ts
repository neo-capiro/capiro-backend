import { createHash } from 'node:crypto';
import {
  currentOwnerReauthorizationInput,
  currentOwnerResultAuthorizesReplay,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization';
import { publicResearchSourceTool } from './meri-report-provenance';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const clone = <T>(value: T): T => structuredClone(value);

function threadResult(body = 'Complete canonical message body.') {
  return {
    threadId: '11111111-1111-4111-8111-111111111111',
    subject: 'Action needed',
    mailbox: 'owner@example.test',
    messageId: null,
    messageOffset: 0,
    totalMessages: 1,
    returned: 1,
    hasMore: false,
    nextMessageOffset: null,
    sourceProof: {
      version: 1,
      threadId: '11111111-1111-4111-8111-111111111111',
      mailboxId: 'mailbox-1',
      mailboxStatus: 'connected',
      clientId: 'client-1',
      threadUpdatedAt: '2026-09-28T00:00:00.000Z',
    },
    messages: [{
      id: '22222222-2222-4222-8222-222222222222',
      threadId: '11111111-1111-4111-8111-111111111111',
      subject: 'Action needed',
      from: { email: 'sender@example.test', name: 'Sender' },
      to: [{ email: 'owner@example.test', name: 'Owner' }],
      cc: [],
      sentAt: '2026-09-27T12:00:00.000Z',
      receivedAt: null,
      bodyText: body,
      bodyOffset: 0,
      bodyLength: body.length,
      bodyCompleteness: 'full',
      bodyTruncated: false,
      nextBodyOffset: null,
      sourceProof: {
        version: 1,
        mailboxId: 'mailbox-1',
        threadId: '11111111-1111-4111-8111-111111111111',
        messageId: '22222222-2222-4222-8222-222222222222',
        messageUpdatedAt: '2026-09-28T00:01:00.000Z',
        bodySha256: sha(body),
      },
    }],
  };
}

function searchResult(tool: 'list_emails' | 'search_emails' = 'search_emails', empty = false) {
  const preview = 'Source-owned preview bytes.';
  const messages = empty ? [] : [{
    id: '22222222-2222-4222-8222-222222222222',
    threadId: '11111111-1111-4111-8111-111111111111',
    subject: 'Action needed',
    from: { email: 'sender@example.test', name: 'Sender' },
    to: [{ email: 'owner@example.test', name: 'Owner' }],
    cc: [],
    sentAt: '2026-09-27T12:00:00.000Z',
    receivedAt: '2026-09-27T12:01:00.000Z',
    folder: 'inbox',
    preview,
    hasAttachments: false,
    mailbox: 'owner@example.test',
    client: { id: 'client-1', name: 'Client One' },
    sourceProof: {
      version: 1,
      mailboxId: 'mailbox-1',
      threadId: '11111111-1111-4111-8111-111111111111',
      messageId: '22222222-2222-4222-8222-222222222222',
      messageUpdatedAt: '2026-09-28T00:01:00.000Z',
      previewSha256: sha(preview),
    },
  }];
  const root: Record<string, unknown> = {
    totalMatches: messages.length,
    returned: messages.length,
    hasMore: false,
    offset: 0,
    nextOffset: null,
    asOf: '2026-09-28T00:00:00.000Z',
    queryScope: {
      query: 'action',
      from: null,
      participant: null,
      clientId: 'client-1',
      folder: 'inbox',
      withinDays: 30,
      asOf: '2026-09-28T00:00:00.000Z',
    },
    timeWindow: {
      start: '2026-08-29T00:00:00.000Z',
      end: '2026-09-28T00:00:00.000Z',
    },
    folder: 'inbox',
    clientId: 'client-1',
    messages,
    searchedMailboxes: [{
      accountEmail: 'owner@example.test',
      sourceProof: { version: 1, mailboxId: 'mailbox-1' },
      provider: 'microsoft_365',
      status: 'connected',
      lastSyncAt: '2026-09-28T00:00:00.000Z',
      connectionLastSyncAt: '2026-09-28T00:00:00.000Z',
      syncedMessages: 10,
      syncedRange: {
        oldest: '2026-08-28T00:00:00.000Z',
        newest: '2026-09-28T00:00:00.000Z',
      },
      mailCoverage: {
        sourceStatus: 'healthy',
        reason: null,
        lastMailSyncAt: '2026-09-28T00:00:00.000Z',
        lastConnectionSyncAt: '2026-09-28T00:00:00.000Z',
        backfillComplete: true,
        hasMore: false,
        captureRepair: 'complete',
      },
    }],
    notes: ['Canonical bounded mail result.'],
  };
  if (tool === 'list_emails') {
    root.count = messages.length;
    root.threads = empty ? [] : [{
      id: messages[0]!.threadId,
      subject: messages[0]!.subject,
      snippet: messages[0]!.preview,
      messages: [{
        id: messages[0]!.id,
        subject: messages[0]!.subject,
        fromEmail: messages[0]!.from.email,
        fromName: messages[0]!.from.name,
        bodyText: messages[0]!.preview,
        sentAt: messages[0]!.sentAt,
        receivedAt: messages[0]!.receivedAt,
      }],
    }];
  }
  return root;
}

describe('canonical durable mail owner proof', () => {
  it('publishes only the three finite canonical mail tool names', () => {
    for (const tool of ['list_emails', 'search_emails', 'get_email_thread']) {
      expect(supportsDurableOwnerReauthorization(tool)).toBe(true);
      expect(publicResearchSourceTool(tool)).toBe(tool);
    }
    expect(supportsDurableOwnerReauthorization('gmail_search')).toBe(false);
    expect(publicResearchSourceTool('gmail_search')).toBeNull();
    expect(publicResearchSourceTool('provider_mail_read')).toBeNull();
  });

  it.each(['search_emails', 'list_emails'] as const)(
    'binds complete %s previews, owner mailbox identity, client scope and healthy coverage',
    (tool) => {
      const saved = searchResult(tool);
      expect(currentOwnerResultAuthorizesReplay(tool, saved, clone(saved))).toBe(true);

      const edited = clone(saved) as any;
      edited.messages[0].preview = 'Edited source preview.';
      expect(currentOwnerResultAuthorizesReplay(tool, saved, edited)).toBe(false);

      const changedClient = clone(saved) as any;
      changedClient.messages[0].client.id = 'client-2';
      expect(currentOwnerResultAuthorizesReplay(tool, saved, changedClient)).toBe(false);

      const changedSentAt = clone(saved) as any;
      changedSentAt.messages[0].sentAt = '2026-09-27T13:00:00.000Z';
      if (tool === 'list_emails')
        changedSentAt.threads[0].messages[0].sentAt = changedSentAt.messages[0].sentAt;
      expect(currentOwnerResultAuthorizesReplay(tool, saved, changedSentAt)).toBe(false);

      const changedSync = clone(saved) as any;
      changedSync.searchedMailboxes[0].lastSyncAt = '2026-09-28T00:05:00.000Z';
      expect(currentOwnerResultAuthorizesReplay(tool, saved, changedSync)).toBe(false);
    },
  );

  it('accepts only an owner-proven healthy complete empty search', () => {
    const empty = searchResult('search_emails', true);
    expect(currentOwnerResultAuthorizesReplay('search_emails', empty, clone(empty))).toBe(true);

    const unavailable = clone(empty) as any;
    unavailable.searchedMailboxes[0].status = 'needs_configuration';
    unavailable.searchedMailboxes[0].mailCoverage.sourceStatus = 'unavailable';
    unavailable.searchedMailboxes[0].mailCoverage.reason = 'mailbox_not_connected';
    expect(currentOwnerResultAuthorizesReplay('search_emails', empty, unavailable)).toBe(false);

    const noOwner = clone(empty) as any;
    noOwner.searchedMailboxes = [];
    expect(currentOwnerResultAuthorizesReplay('search_emails', empty, noOwner)).toBe(false);
  });

  it('reconstructs an omitted search asOf from the validated canonical result only', () => {
    const saved = searchResult('search_emails');
    const input = {
      query: 'action', folder: 'inbox', withinDays: 30, clientId: 'client-1',
    };
    expect(currentOwnerReauthorizationInput('search_emails', input, saved)).toEqual({
      ...input,
      asOf: '2026-09-28T00:00:00.000Z',
    });
    expect(currentOwnerReauthorizationInput('search_emails', {
      ...input,
      query: 'different',
    }, saved)).toBeNull();
    expect(currentOwnerReauthorizationInput('search_emails', {
      ...input,
      asOf: '2026-09-28T00:00:00.000Z',
    }, saved)).toEqual({ ...input, asOf: '2026-09-28T00:00:00.000Z' });
  });

  it('binds complete thread bodies and rejects revoked, removed, edited, partial and malformed owners', () => {
    const saved = threadResult();
    expect(currentOwnerResultAuthorizesReplay('get_email_thread', saved, clone(saved))).toBe(true);

    const cases = [
      (value: any) => { value.sourceProof.mailboxStatus = 'revoked'; },
      (value: any) => { value.messages = []; value.totalMessages = 0; value.returned = 0; },
      (value: any) => { value.messages[0].bodyText = 'Body edited without owner hash.'; },
      (value: any) => { value.sourceProof.clientId = 'client-2'; },
      (value: any) => { value.messages[0].bodyCompleteness = 'preview'; },
      (value: any) => { value.messages[0].bodyCompleteness = 'unknown'; },
      (value: any) => { value.messages[0].bodyTruncated = true; value.messages[0].nextBodyOffset = 10; },
      (value: any) => { value.returned = 2; },
    ];
    for (const mutate of cases) {
      const current = clone(saved);
      mutate(current);
      expect(currentOwnerResultAuthorizesReplay('get_email_thread', saved, current)).toBe(false);
    }
  });
});
