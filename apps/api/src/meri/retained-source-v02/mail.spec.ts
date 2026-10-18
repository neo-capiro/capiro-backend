import { createHash } from 'node:crypto';
import {
  MailRetainedSourceUnavailable,
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
const inventory = [{sourceProof: {version: 1, mailboxId}, status: 'active'}];

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
        connectionStatus: 'active', readHandle: 'owner-read:mail:1', scopes: [mailboxScope],
        sourceProof: {version: 1, mailboxId, threadId, messageId,
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
      sourceProof: {version: 1, mailboxId, threadId, mailboxStatus: 'active', clientId: null},
      mailboxInventory: inventory,
      messages: [{id: messageId, threadId, bodyText: body, bodyOffset: 0,
        bodyLength: body.length, nextBodyOffset: null, bodyCompleteness: 'full',
        removed: false, connectionStatus: 'active', readHandle: 'owner-read:body:1',
        scopes: [mailboxScope], sourceProof: {version: 1, mailboxId, threadId, messageId,
          messageUpdatedAt: anchor,
          bodySha256: createHash('sha256').update(body, 'utf8').digest('hex')}}]},
  };
}

const unavailable = (reason: string) => new MailRetainedSourceUnavailable(reason);

describe('mail retained 0.2 source projection', () => {
  it('projects a bounded candidate page with explicit owner inventory and no source completion claim', () => {
    const page = projectMailRetainedSourceV02(candidate()) as any;
    expect(page.operation).toEqual({id: 'mail.list_messages', version: '0.2.0'});
    expect(page.messages[0]).toMatchObject({mailboxId, threadId, messageId,
      readHandle: 'owner-read:mail:1', recordVersionId: null,
      preview: {kind: 'incomplete-preview', fullSizeKnown: false}});
    expect(page.queryScope).toEqual({asOfInclusive: anchor, storedCreatedAtEndInclusive: anchor,
      effectiveStartInclusive: null, missingEffectiveDates: 'included'});
    expect(page.coverage).toMatchObject({enumeration: 'unknown', returnedCount: 1,
      sourcesChecked: ['mail']});
    expect(page.sources[0]).toMatchObject({snapshotVersionId: null, freshness: 'unknown', status: 'partial'});
    expect(page).toMatchObject({evidenceReady: false, negativeAssertion: {kind: 'none'},
      snapshotVersionId: null, threadGroups: [{mailboxId, threadId, messageIds: [messageId]}]});
  });

  it('refuses absent inventory, handle, scoped lineage, or anchor', () => {
    const noInventory = candidate(); (noInventory.ownerResult as any).searchedMailboxes = [];
    expect(() => projectMailRetainedSourceV02(noInventory)).toThrow(unavailable('mailbox_inventory'));
    const noHandle = candidate(); delete (noHandle.ownerResult as any).messages[0].readHandle;
    expect(() => projectMailRetainedSourceV02(noHandle)).toThrow(unavailable('message.read_handle'));
    const noScope = candidate(); (noScope.ownerResult as any).messages[0].scopes = [];
    expect(() => projectMailRetainedSourceV02(noScope)).toThrow(unavailable('message.scopes'));
    const noAnchor = candidate(); delete (noAnchor.ownerResult as any).asOf;
    expect(() => projectMailRetainedSourceV02(noAnchor)).toThrow(unavailable('owner.anchor'));
  });

  it('projects an exact UTF-16 body section and refuses missing body proof', () => {
    const page = projectMailRetainedSourceV02(thread()) as any;
    expect(page.messages[0].section).toEqual({start: 0, endExclusive: 4,
      totalCodeUnits: 4, unit: 'utf16-code-unit', text: 'A😀Z', hasMore: false});
    expect(page.continuation.requiredReads).toEqual(['owner-read:body:1']);
    const noBody = thread(); delete (noBody.ownerResult as any).messages[0].bodyLength;
    expect(() => projectMailRetainedSourceV02(noBody)).toThrow(unavailable('thread.body_length'));
    const noBodyHash = thread(); delete (noBodyHash.ownerResult as any).messages[0].sourceProof.bodySha256;
    expect(() => projectMailRetainedSourceV02(noBodyHash)).toThrow(unavailable('thread.body_hash'));
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
