import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MailRetainedSourceUnavailable,
  createMailBodySectionV02,
  mailRetainedReadHandleV02,
  projectMailRetainedSourceV02,
  type MailRetainedProjectionInput,
} from './mail.js';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const readAt = '2026-10-18T12:00:00.000Z';
const anchor = '2026-10-18T11:59:59.000Z';
const mailboxId = id('a'), threadId = id('b'), messageId = id('c');
const binding = {tenantId: id('1'), actorId: id('2'), conversationId: id('3'), runId: id('4'),
  attemptId: id('5'), workerId: id('6'), writerFence: 1};
const mailboxScope = {tenantId: binding.tenantId, kind: 'mailbox', resourceId: mailboxId, policyRevision: 'p1'};
const subject = {kind: 'personal', entityType: 'user', entityIds: [binding.actorId],
  tenantId: binding.tenantId, actorId: binding.actorId, authorizationDecisionId: id('7'),
  policyRevision: 'p1', scopes: [mailboxScope], rosterVersionId: null};
const inventory = [{sourceProof: {version: 1, mailboxId,
  ownerTenantId: binding.tenantId, ownerActorId: binding.actorId}, status: 'active'}];
const handle = mailRetainedReadHandleV02(mailboxId, threadId, messageId, anchor);

function candidate(): MailRetainedProjectionInput {
  return {
    operation: 'mail.list_messages', binding, subject, readAt, requestId: id('8'), traceId: id('9'),
    selection: {subject: {kind: 'personal'}, folder: 'all', withinDays: null,
      limit: 1, offset: 0, asOf: null},
    ownerResult: {asOf: anchor, offset: 0, folder: 'all',
      queryScope: {asOf: anchor, folder: 'all', withinDays: null,
        query: null, from: null, participant: null, clientId: null},
      timeWindow: {start: null, end: anchor}, searchedMailboxes: inventory,
      totalMatches: 1, returned: 1, hasMore: false, nextOffset: null,
      messages: [{id: messageId, threadId, subject: 'Source subject',
        from: {email: 'sender@example.test', name: null}, to: [], cc: [],
        sentAt: null, receivedAt: anchor, createdAt: anchor,
        preview: 'A bounded preview', client: null, internetMessageId: null,
        toTruncated: false, ccTruncated: false, removed: false,
        connectionStatus: 'active',
        sourceProof: {version: 1, mailboxId, threadId, messageId,
          ownerTenantId: binding.tenantId, ownerActorId: binding.actorId,
          messageUpdatedAt: anchor,
          previewSha256: createHash('sha256').update('A bounded preview', 'utf8').digest('hex')}}]},
  };
}

function thread(): MailRetainedProjectionInput {
  const body = 'A😀Z';
  return {
    operation: 'mail.read_thread', binding, subject, readAt, requestId: id('8'), traceId: id('9'),
    selection: {subject: {kind: 'personal'}, threadId, messageId: null,
      messageOffset: 0, bodyOffset: 0, limit: 1, maxCharacters: 10},
    ownerResult: {threadId, messageId: null, messageOffset: 0, totalMessages: 1,
      returned: 1, hasMore: false, nextMessageOffset: null,
      sourceProof: {version: 1, mailboxId, threadId, mailboxStatus: 'active', clientId: null,
        ownerTenantId: binding.tenantId, ownerActorId: binding.actorId},
      mailboxInventory: inventory,
      messages: [{id: messageId, threadId, bodyText: body, bodyOffset: 0,
        bodyLength: body.length, bodyTruncated: false,
        nextBodyOffset: null, bodyCompleteness: 'full',
        removed: false, connectionStatus: 'active', bodyStoredPresent: true,
        sourceProof: {version: 1, mailboxId, threadId, messageId,
          ownerTenantId: binding.tenantId, ownerActorId: binding.actorId,
          messageUpdatedAt: anchor,
          bodySha256: createHash('sha256').update(body, 'utf8').digest('hex')}}]},
  };
}

const unavailable = (reason: string) => new MailRetainedSourceUnavailable(reason);

describe('mail retained 0.2 source projection', () => {
  it('keeps the exact PR158 schema dependency closure pinned', () => {
    const files = {
      'mail-base.schema.json': 'e3de878198bbd557843ac440e48664ad5175eecd99f7ec932021ffc465bf8c5b',
      'mail-common.schema.json': '7d7ac22eff809cc31e84d1fc9b2fada1b56c316f73e50115207b579de0d92c4b',
      'mail-retrieval.schema.json': '6058aa0d735b595a093907eec8bf7e4e8f4eb96952f497caa3c1eb00f3ad1a8c',
      'mail.schema.json': 'd45681f76ba5f5d7f65b7385ab1e1c3deb9626d4166e55fc6039e88bc3d804e6',
    };
    for (const [name, expected] of Object.entries(files))
      expect(createHash('sha256').update(readFileSync(join(__dirname, name))).digest('hex')).toBe(expected);
  });

  it('projects a bounded candidate page with explicit owner inventory and no source completion claim', () => {
    const page = projectMailRetainedSourceV02(candidate()) as any;
    expect(page.operation).toEqual({id: 'mail.list_messages', version: '0.2.0'});
    expect(page.messages[0]).toMatchObject({mailboxId, threadId, messageId,
      readHandle: handle, recordVersionId: null,
      preview: {kind: 'incomplete-preview', fullSizeKnown: false}});
    expect(page.queryScope).toEqual({asOfInclusive: anchor, storedCreatedAtEndInclusive: anchor,
      effectiveStartInclusive: null, missingEffectiveDates: 'included'});
    expect(page.coverage).toMatchObject({enumeration: 'unknown', returnedCount: 1,
      sourcesChecked: ['mail']});
    expect(page.sources[0]).toMatchObject({snapshotVersionId: null, freshness: 'unknown', status: 'partial'});
    expect(page).toMatchObject({evidenceReady: false, negativeAssertion: {kind: 'none'},
      snapshotVersionId: null, threadGroups: [{mailboxId, threadId, messageIds: [messageId]}]});
  });

  it('preserves a Meri UTC asOf spelling while checking the owner SQL instant', () => {
    const input = candidate(); (input.selection as any).asOf = '2026-10-18T11:59:59Z';
    const page = projectMailRetainedSourceV02(input) as any;
    expect(page.queryScope.asOfInclusive).toBe('2026-10-18T11:59:59Z');
    const submillisecond = candidate();
    (submillisecond.selection as any).asOf = '2026-10-18T11:59:59.000001Z';
    expect(() => projectMailRetainedSourceV02(submillisecond))
      .toThrow(unavailable('selection.asOf'));
  });

  it('refuses absent inventory, owner scope, version-bound handle facts, or anchor', () => {
    const noInventory = candidate(); (noInventory.ownerResult as any).searchedMailboxes = [];
    expect(() => projectMailRetainedSourceV02(noInventory)).toThrow(unavailable('mailbox_inventory'));
    const noVersion = candidate(); delete (noVersion.ownerResult as any).messages[0].sourceProof.messageUpdatedAt;
    expect(() => projectMailRetainedSourceV02(noVersion)).toThrow(unavailable('read_handle.message_version'));
    const wrongOwner = candidate(); (wrongOwner.ownerResult as any).messages[0].sourceProof.ownerActorId = id('f');
    expect(() => projectMailRetainedSourceV02(wrongOwner)).toThrow(unavailable('message.owner_scope'));
    const unknownRecipients = candidate(); (unknownRecipients.ownerResult as any).messages[0].toTruncated = null;
    expect(() => projectMailRetainedSourceV02(unknownRecipients)).toThrow(unavailable('message.preview'));
    const noAnchor = candidate(); delete (noAnchor.ownerResult as any).asOf;
    expect(() => projectMailRetainedSourceV02(noAnchor)).toThrow(unavailable('owner.anchor'));
    const extraBindingField = candidate(); extraBindingField.binding = {...binding, unexpected: true};
    expect(() => projectMailRetainedSourceV02(extraBindingField)).toThrow(unavailable('output.schema'));
  });

  it('projects an exact UTF-16 body section and refuses missing body proof', () => {
    const page = projectMailRetainedSourceV02(thread()) as any;
    expect(page.messages[0].section).toEqual({start: 0, endExclusive: 4,
      totalCodeUnits: 4, unit: 'utf16-code-unit', text: 'A😀Z', hasMore: false});
    expect(page.continuation.requiredReads).toEqual([handle]);
    const noStoredBody = thread(); delete (noStoredBody.ownerResult as any).messages[0].bodyStoredPresent;
    expect(() => projectMailRetainedSourceV02(noStoredBody)).toThrow(unavailable('thread.utf16_evidence'));
    const noBody = thread(); delete (noBody.ownerResult as any).messages[0].bodyLength;
    expect(() => projectMailRetainedSourceV02(noBody)).toThrow(unavailable('thread.body_length'));
    const noBodyHash = thread(); delete (noBodyHash.ownerResult as any).messages[0].sourceProof.bodySha256;
    expect(() => projectMailRetainedSourceV02(noBodyHash)).toThrow(unavailable('thread.body_hash'));
  });

  it('uses Meri scalar-safe UTF-16 positions for astral and beyond-end reads', () => {
    expect(createMailBodySectionV02('A😀Z', 2, 1)).toEqual({
      bodyText: '😀', bodyOffset: 1, bodyLength: 4,
      bodyTruncated: true, nextBodyOffset: 3,
    });
    expect(createMailBodySectionV02('A😀Z', 20, 1)).toEqual({
      bodyText: '', bodyOffset: 4, bodyLength: 4,
      bodyTruncated: true, nextBodyOffset: null,
    });
    expect(() => createMailBodySectionV02('A\uD83D', 0, 1))
      .toThrow(unavailable('thread.body_text'));
    const input = thread();
    (input.selection as any).messageId = messageId;
    (input.selection as any).bodyOffset = 2;
    (input.selection as any).maxCharacters = 1;
    (input.ownerResult as any).messageId = messageId;
    const body = createMailBodySectionV02('A😀Z', 2, 1);
    Object.assign((input.ownerResult as any).messages[0], body);
    const page = projectMailRetainedSourceV02(input) as any;
    expect(page.messages[0].section).toMatchObject({start: 1, endExclusive: 3,
      text: '😀', hasMore: true});
  });

  it('refuses a selected client projection that contains another client', () => {
    const input = candidate();
    const clientId = id('d'), foreignId = id('e');
    input.subject = {...subject, kind: 'client', entityType: 'client', entityIds: [clientId],
      scopes: [mailboxScope, {tenantId: binding.tenantId, kind: 'client', resourceId: clientId, policyRevision: 'p1'}]};
    (input.selection as any).subject = {kind: 'client', entityId: clientId};
    (input.ownerResult as any).queryScope.clientId = clientId;
    (input.ownerResult as any).messages[0].client = {id: foreignId, name: 'Foreign'};
    expect(() => projectMailRetainedSourceV02(input)).toThrow(unavailable('message.client_scope'));
  });
});
