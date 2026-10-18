/**
 * Pure preparation for Meri's mail 0.2 passive source pages. The caller must
 * supply a current, authorized Core owner read and its mailbox inventory. This
 * module neither opens a mailbox nor grants access to one. In particular, the
 * ordinary list_emails/get_email_thread results are not sufficient until their
 * owner supplies read handles, per-row scopes, and the missing source lineage.
 */
import { createHash } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';

export type MailRetainedOperationV02 =
  | 'mail.list_messages'
  | 'mail.search_messages'
  | 'mail.read_thread';

export class MailRetainedSourceUnavailable extends Error {
  constructor(reason: string) {
    super(`MAIL_RETAINED_SOURCE_UNAVAILABLE:${reason}`);
    this.name = 'MailRetainedSourceUnavailable';
  }
}

export type MailRetainedProjectionInput = {
  operation: MailRetainedOperationV02;
  /** The route must obtain these from its current, verified Meri task. */
  binding: unknown;
  subject: unknown;
  selection: unknown;
  /** Result of the current canonical mail owner, including same-read inventory. */
  ownerResult: unknown;
  /** Exact read observation time, supplied by the owner rather than this module. */
  readAt: string;
  requestId: string;
  traceId: string;
};

type JsonObject = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

function refuse(reason: string): never {
  throw new MailRetainedSourceUnavailable(reason);
}
function object(value: unknown, reason: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(reason);
  return value as JsonObject;
}
function array(value: unknown, reason: string): unknown[] {
  if (!Array.isArray(value)) refuse(reason);
  return value;
}
function string(value: unknown, reason: string): string {
  if (typeof value !== 'string' || !value.trim()) refuse(reason);
  return value;
}
function uuid(value: unknown, reason: string): string {
  const result = string(value, reason);
  if (!UUID.test(result)) refuse(reason);
  return result;
}
function instant(value: unknown, reason: string): string {
  const result = string(value, reason);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) refuse(reason);
  return result;
}
function integer(value: unknown, min: number, max: number, reason: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) refuse(reason);
  return value as number;
}
function json<T>(value: T, reason: string): T {
  try { return JSON.parse(canonicalizeCoreRetainedJson(value)) as T; }
  catch { return refuse(reason); }
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalizeCoreRetainedJson(value), 'utf8').digest('hex');
}
function textHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function same(left: unknown, right: unknown): boolean {
  try { return canonicalizeCoreRetainedJson(left) === canonicalizeCoreRetainedJson(right); }
  catch { return false; }
}
function exactFields(value: JsonObject, fields: string[], reason: string) {
  if (Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) refuse(reason);
}

function trustedTask(bindingValue: unknown, subjectValue: unknown, requested: unknown) {
  const binding = json(object(bindingValue, 'binding'), 'binding');
  const subject = json(object(subjectValue, 'subject'), 'subject');
  const selection = json(object(requested, 'selection'), 'selection');
  for (const key of ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId'])
    string(binding[key], `binding.${key}`);
  integer(binding.writerFence, 1, Number.MAX_SAFE_INTEGER, 'binding.writerFence');
  if (subject.tenantId !== binding.tenantId || subject.actorId !== binding.actorId ||
      !['personal', 'client'].includes(String(subject.kind))) refuse('subject.binding');
  const ids = array(subject.entityIds, 'subject.entityIds');
  if (ids.length !== 1) refuse('subject.entityIds');
  const scopes = array(subject.scopes, 'subject.scopes').map(value => object(value, 'subject.scope'));
  if (!scopes.some(scope => scope.kind === 'mailbox' && scope.tenantId === binding.tenantId))
    refuse('subject.mailbox_scope');
  const requestedSubject = object(selection.subject, 'selection.subject');
  exactFields(requestedSubject, subject.kind === 'client' ? ['kind', 'entityId'] : ['kind'],
    'selection.subject');
  if (requestedSubject.kind !== subject.kind ||
      (subject.kind === 'client' && (requestedSubject.entityId !== ids[0] || subject.entityType !== 'client')) ||
      (subject.kind === 'personal' && (ids[0] !== binding.actorId || subject.entityType !== 'user')))
    refuse('selection.subject');
  return {binding, subject, selection, scopes};
}

function mailboxInventory(value: unknown, scopes: JsonObject[]) {
  const entries = array(value, 'mailbox_inventory');
  if (entries.length < 1 || entries.length > 4096) refuse('mailbox_inventory');
  const seen = new Set<string>(), statuses = new Map<string, string>();
  for (const entry of entries) {
    const box = object(entry, 'mailbox_inventory.entry');
    const proof = object(box.sourceProof, 'mailbox_inventory.source_proof');
    if (proof.version !== 1) refuse('mailbox_inventory.source_proof');
    const id = uuid(proof.mailboxId, 'mailbox_inventory.id');
    if (seen.has(id) || !scopes.some(scope => scope.kind === 'mailbox' && scope.resourceId === id))
      refuse('mailbox_inventory.scope');
    seen.add(id);
    statuses.set(id, string(box.status, 'mailbox_inventory.status'));
  }
  return statuses;
}

function rowScopes(value: unknown, subjectScopes: JsonObject[], mailboxId: string) {
  const scopes = array(value, 'message.scopes').map(scope => object(scope, 'message.scope'));
  if (!scopes.length || !scopes.some(scope => scope.kind === 'mailbox' && scope.resourceId === mailboxId) ||
      scopes.some(scope => !subjectScopes.some(parent => same(scope, parent)))) refuse('message.scopes');
  return scopes;
}

function sourceEnvelope(readAt: string, count: number, total: number, truncated: boolean,
  handles: string[], limitations: string[]) {
  return {
    // The stored owner has no immutable snapshot or complete mailbox history.
    window: {basis: 'unbounded'}, appliedFilters: [], snapshotVersionId: null,
    sources: [{sourceId: 'mail', authority: 'authoritative', snapshotVersionId: null,
      adapterVersion: '0.2.0', status: 'partial', synchronizedAt: null, asOf: null,
      retrievedAt: readAt, freshness: 'unknown'}],
    coverage: {sourcesRequested: ['mail'], sourcesChecked: ['mail'], sourcesUnavailable: [],
      enumeration: 'unknown', enumerableTotal: total, returnedCount: count, truncated,
      historySupport: 'bounded', limitations},
    continuation: {cursor: null, requiredReads: handles, remainingSources: []},
    evidenceReady: false, negativeAssertion: {kind: 'none'},
  };
}

function candidatePage(operation: 'mail.list_messages' | 'mail.search_messages',
  binding: JsonObject, subject: JsonObject, selection: JsonObject, owner: JsonObject,
  scopes: JsonObject[], readAt: string, requestId: string, traceId: string) {
  exactFields(selection, operation === 'mail.list_messages'
    ? ['subject', 'folder', 'withinDays', 'limit', 'offset', 'asOf']
    : ['subject', 'folder', 'withinDays', 'limit', 'offset', 'asOf', 'query', 'from', 'participant'],
  'selection.fields');
  const boxes = mailboxInventory(owner.searchedMailboxes, scopes);
  const folder = selection.folder;
  if (!['all', 'inbox', 'sent'].includes(String(folder))) refuse('selection.folder');
  const limit = integer(selection.limit, 1, 50, 'selection.limit');
  const offset = integer(selection.offset, 0, 10000, 'selection.offset');
  const withinDays = selection.withinDays === null ? null :
    integer(selection.withinDays, 1, 3650, 'selection.withinDays');
  const asOf = selection.asOf === null ? null : instant(selection.asOf, 'selection.asOf');
  if (offset > 0 && asOf === null) refuse('selection.continuation_anchor');
  if (operation === 'mail.search_messages') {
    for (const key of ['query', 'from', 'participant']) {
      if (typeof selection[key] !== 'string' || (selection[key] as string).length > 200 ||
          (selection[key] as string).trim() !== selection[key]) refuse(`selection.${key}`);
    }
    if (!selection.query && !selection.from && !selection.participant && withinDays === null && folder === 'all')
      refuse('selection.unbounded_search');
  }
  const anchor = instant(owner.asOf, 'owner.anchor');
  if (asOf !== null && anchor !== asOf || Date.parse(anchor) > Date.parse(readAt) + 1000)
    refuse('owner.anchor');
  const query = object(owner.queryScope, 'owner.query_scope');
  const selectedClient = subject.kind === 'client' ? array(subject.entityIds, 'subject.entityIds')[0] : null;
  if (query.asOf !== anchor || query.folder !== folder || query.withinDays !== withinDays ||
      (operation === 'mail.search_messages' &&
       (query.query !== (selection.query || null) || query.from !== (selection.from || null) ||
        query.participant !== (selection.participant || null))) ||
      (operation === 'mail.list_messages' &&
       (query.query !== null || query.from !== null || query.participant !== null)) ||
      query.clientId !== selectedClient ||
      owner.offset !== offset || owner.folder !== folder) refuse('owner.query_scope');
  const timeWindow = object(owner.timeWindow, 'owner.time_window');
  const expectedStart = withinDays === null ? null :
    new Date(Date.parse(anchor) - withinDays * 86400000).toISOString();
  if (timeWindow.end !== anchor || timeWindow.start !== expectedStart) refuse('owner.time_window');
  const ownerRows = array(owner.messages, 'owner.messages');
  const total = integer(owner.totalMatches, 0, Number.MAX_SAFE_INTEGER, 'owner.total');
  const expected = Math.min(limit, Math.max(0, total - offset));
  if (ownerRows.length !== expected || owner.returned !== expected) refuse('owner.page_count');
  const hasMore = offset + expected < total;
  const nextOffset = hasMore && expected > 0 && offset + expected <= 10000 ? offset + expected : null;
  if (owner.hasMore !== hasMore || owner.nextOffset !== nextOffset) refuse('owner.continuation');
  const messages: JsonObject[] = [], handles = new Set<string>(), identities = new Set<string>(),
    dedupe = new Set<string>();
  for (const item of ownerRows) {
    const row = object(item, 'owner.message');
    const proof = object(row.sourceProof, 'message.source_proof');
    if (proof.version !== 1) refuse('message.source_proof');
    const mailboxId = uuid(proof.mailboxId, 'message.mailbox_id');
    const messageId = uuid(row.id, 'message.id'), threadId = uuid(row.threadId, 'message.thread_id');
    if (mailboxId !== proof.mailboxId || !boxes.has(mailboxId) || proof.messageId !== messageId ||
        proof.threadId !== threadId || row.removed !== false || row.connectionStatus !== boxes.get(mailboxId))
      refuse('message.owner_lineage');
    const readHandle = string(row.readHandle, 'message.read_handle');
    if (readHandle.length > 256 || handles.has(readHandle)) refuse('message.read_handle');
    handles.add(readHandle);
    const rowScope = rowScopes(row.scopes, scopes, mailboxId);
    const createdAt = instant(row.createdAt, 'message.created_at');
    const receivedAt = row.receivedAt === null ? null : instant(row.receivedAt, 'message.received_at');
    const sentAt = row.sentAt === null ? null : instant(row.sentAt, 'message.sent_at');
    const effectiveAt = receivedAt ?? sentAt;
    if (Date.parse(createdAt) > Date.parse(anchor) || effectiveAt !== null && Date.parse(effectiveAt) > Date.parse(anchor))
      refuse('message.anchor');
    if (withinDays !== null &&
        (effectiveAt === null || Date.parse(effectiveAt) < Date.parse(anchor) - withinDays * 86400000))
      refuse('message.time_window');
    const client = row.client === null ? null : object(row.client, 'message.client');
    const clientId = client === null ? null : uuid(client.id, 'message.client_id');
    const requestedSubject = object(selection.subject, 'selection.subject');
    if (requestedSubject.kind === 'client' && clientId !== requestedSubject.entityId)
      refuse('message.client_scope');
    if (typeof row.preview !== 'string' && row.preview !== null ||
        typeof row.toTruncated !== 'boolean' || typeof row.ccTruncated !== 'boolean')
      refuse('message.preview');
    const preview = row.preview as string | null;
    if (!Array.isArray(row.to) || !Array.isArray(row.cc) || row.to.length > 8 || row.cc.length > 8 ||
        [...row.to, ...row.cc].some(value => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
          const recipient = value as JsonObject;
          return (recipient.email !== null && typeof recipient.email !== 'string') ||
            (recipient.name !== null && typeof recipient.name !== 'string') ||
            typeof recipient.email === 'string' && recipient.email.length > 1024 ||
            typeof recipient.name === 'string' && recipient.name.length > 1024;
        })) refuse('message.recipients');
    if (preview !== null && Buffer.byteLength(preview, 'utf8') > 65536) refuse('message.preview_bytes');
    if (typeof row.subject !== 'string' && row.subject !== null ||
        typeof row.from !== 'object' || row.from === null || Array.isArray(row.from))
      refuse('message.fields');
    if (typeof row.subject === 'string' && row.subject.length > 8192) refuse('message.subject');
    const sender = object(row.from, 'message.sender');
    if ((sender.email !== null && typeof sender.email !== 'string') ||
        (sender.name !== null && typeof sender.name !== 'string') ||
        typeof sender.email === 'string' && sender.email.length > 1024 ||
        typeof sender.name === 'string' && sender.name.length > 1024) refuse('message.sender');
    if (proof.previewSha256 !== textHash(preview ?? '')) refuse('message.preview_hash');
    const internetMessageId = row.internetMessageId === null ? null :
      string(row.internetMessageId, 'message.internet_id');
    if (internetMessageId !== null && internetMessageId.length > 2048 ||
        (row.connectionStatus as string).length > 128) refuse('message.fields');
    const identity = `${mailboxId}:${messageId}`;
    const dedupeId = `${mailboxId}:${internetMessageId || messageId}`;
    if (identities.has(identity) || dedupe.has(dedupeId)) refuse('message.duplicate');
    identities.add(identity); dedupe.add(dedupeId);
    messages.push({sourceId: 'mail', mailboxId, threadId, messageId,
      recordVersionId: null, citationId: null, scopes: rowScope, removed: false,
      connectionStatus: row.connectionStatus, readHandle, internetMessageId, clientId,
      receivedAt, sentAt, createdAt, effectiveAt, subjectText: row.subject,
      preview: {kind: 'incomplete-preview', text: preview, fullSizeKnown: false},
      from: {email: sender.email, name: sender.name},
      to: row.to.map((value: unknown) => {
        const recipient = object(value, 'message.recipients');
        return {email: recipient.email, name: recipient.name};
      }),
      cc: row.cc.map((value: unknown) => {
        const recipient = object(value, 'message.recipients');
        return {email: recipient.email, name: recipient.name};
      }),
      toTruncated: row.toTruncated, ccTruncated: row.ccTruncated});
  }
  for (let i = 1; i < messages.length; i++) {
    const previous = messages[i - 1], current = messages[i];
    const before = previous.effectiveAt === null ? -Infinity : Date.parse(previous.effectiveAt as string);
    const after = current.effectiveAt === null ? -Infinity : Date.parse(current.effectiveAt as string);
    if (after > before || after === before && String(current.messageId) > String(previous.messageId))
      refuse('message.order');
  }
  const groups: Array<{mailboxId: string; threadId: string; messageIds: string[]}> = [];
  for (const message of messages) {
    let group = groups.find(row => row.mailboxId === message.mailboxId && row.threadId === message.threadId);
    if (!group) {
      group = {mailboxId: message.mailboxId as string, threadId: message.threadId as string, messageIds: []};
      groups.push(group);
    }
    group.messageIds.push(message.messageId as string);
  }
  const effectiveStartInclusive = expectedStart;
  return {
    contractVersion: '0.2.0', kind: 'mail-candidate-source-page',
    operation: {id: operation, version: '0.2.0'}, requestId, traceId, binding, subject,
    argumentsSha256: hash(selection), selection,
    ...sourceEnvelope(readAt, messages.length, total, messages.length > 0 || hasMore, [...handles],
      ['Stored mail only; mailbox history and an immutable source snapshot are unverified.']),
    filterSha256: hash({...selection, offset: 0, asOf: null}),
    order: 'effectiveAt-desc-nullslast_messageId-desc',
    queryScope: {asOfInclusive: anchor, storedCreatedAtEndInclusive: anchor,
      effectiveStartInclusive, missingEffectiveDates: withinDays === null ? 'included' : 'excluded'},
    messages, totalMatches: total, hasMore, nextOffset,
    threadGroups: operation === 'mail.list_messages' ? groups : null,
    returnedThreadGroupCount: operation === 'mail.list_messages' ? groups.length : null,
  };
}

function threadPage(binding: JsonObject, subject: JsonObject, selection: JsonObject, owner: JsonObject,
  scopes: JsonObject[], readAt: string, requestId: string, traceId: string) {
  exactFields(selection,
    ['subject', 'threadId', 'messageId', 'messageOffset', 'bodyOffset', 'limit', 'maxCharacters'],
    'selection.fields');
  const boxes = mailboxInventory(owner.mailboxInventory, scopes);
  const threadId = uuid(selection.threadId, 'selection.thread_id');
  const messageId = selection.messageId === null ? null : uuid(selection.messageId, 'selection.message_id');
  const offset = integer(selection.messageOffset, 0, 10000, 'selection.message_offset');
  const bodyOffset = integer(selection.bodyOffset, 0, 10000000, 'selection.body_offset');
  const limit = integer(selection.limit, 1, 10, 'selection.limit');
  const maxCharacters = integer(selection.maxCharacters, 1, 6000, 'selection.max_characters');
  if (bodyOffset > 0 && messageId === null || owner.threadId !== threadId ||
      owner.messageId !== messageId || owner.messageOffset !== offset) refuse('owner.thread_selection');
  const proof = object(owner.sourceProof, 'thread.source_proof');
  if (proof.version !== 1 || proof.threadId !== threadId) refuse('thread.source_proof');
  const mailboxId = uuid(proof.mailboxId, 'thread.mailbox_id');
  if (!boxes.has(mailboxId) || proof.mailboxStatus !== boxes.get(mailboxId)) refuse('thread.mailbox_inventory');
  const requestedSubject = object(selection.subject, 'selection.subject');
  if (requestedSubject.kind === 'client' && proof.clientId !== requestedSubject.entityId)
    refuse('thread.client_scope');
  const rows = array(owner.messages, 'thread.messages');
  const total = integer(owner.totalMessages, 0, Number.MAX_SAFE_INTEGER, 'thread.total');
  if (messageId !== null && total > 1) refuse('thread.exact_message');
  const expected = Math.min(limit, Math.max(0, total - offset));
  if (rows.length !== expected || owner.returned !== expected) refuse('thread.page_count');
  const hasMore = offset + expected < total;
  const nextOffset = hasMore ? offset + expected : null;
  if (owner.hasMore !== hasMore || owner.nextMessageOffset !== nextOffset)
    refuse('thread.continuation');
  const messages: JsonObject[] = [], handles = new Set<string>(), nextBodyOffsets: JsonObject[] = [];
  for (const item of rows) {
    const row = object(item, 'thread.message');
    const sourceProof = object(row.sourceProof, 'thread.message_proof');
    const id = uuid(row.id, 'thread.message_id');
    if (sourceProof.version !== 1 || sourceProof.mailboxId !== mailboxId ||
        sourceProof.threadId !== threadId || sourceProof.messageId !== id ||
        row.threadId !== threadId || messageId !== null && id !== messageId ||
        row.removed !== false || row.connectionStatus !== boxes.get(mailboxId))
      refuse('thread.message_lineage');
    const readHandle = string(row.readHandle, 'thread.read_handle');
    if (readHandle.length > 256 || handles.has(readHandle)) refuse('thread.read_handle');
    handles.add(readHandle);
    const rowScope = rowScopes(row.scopes, scopes, mailboxId);
    if (typeof row.bodyText !== 'string' || !['full', 'preview', 'truncated', 'unknown'].includes(String(row.bodyCompleteness)))
      refuse('thread.utf16_evidence');
    const bodyText = row.bodyText as string;
    const start = integer(row.bodyOffset, 0, 10000000, 'thread.body_offset');
    const totalUnits = integer(row.bodyLength, 0, Number.MAX_SAFE_INTEGER, 'thread.body_length');
    const endExclusive = start + bodyText.length;
    if (start !== bodyOffset || bodyText.length > maxCharacters || endExclusive > totalUnits ||
        endExclusive > 10006000 || bodyText.length === 0 && totalUnits > start)
      refuse('thread.utf16_window');
    const more = endExclusive < totalUnits;
    if (row.nextBodyOffset !== (more ? endExclusive : null)) refuse('thread.utf16_continuation');
    const contentSha256 = string(sourceProof.bodySha256, 'thread.body_hash');
    if (!SHA256.test(contentSha256) || start === 0 && !more && textHash(bodyText) !== contentSha256)
      refuse('thread.body_hash');
    const recordVersionId = sourceProof.messageUpdatedAt === null ? null :
      instant(sourceProof.messageUpdatedAt, 'thread.record_version');
    const section = {start, endExclusive, totalCodeUnits: totalUnits,
      unit: 'utf16-code-unit', text: bodyText, hasMore: more};
    messages.push({sourceId: 'mail', mailboxId, threadId, messageId: id,
      recordVersionId, citationId: null, contentSha256, scopes: rowScope,
      removed: false, connectionStatus: row.connectionStatus,
      bodyCompleteness: row.bodyCompleteness, readHandle, section});
    if (more) nextBodyOffsets.push({messageId: id, bodyOffset: endExclusive});
  }
  return {
    kind: 'mail-thread-source-page', contractVersion: '0.2.0',
    operation: {id: 'mail.read_thread', version: '0.2.0'}, requestId, traceId,
    binding, subject, argumentsSha256: hash(selection), selection,
    ...sourceEnvelope(readAt, messages.length, total,
      nextBodyOffsets.length > 0 || hasMore || messages.some(row => row.bodyCompleteness !== 'full'),
      [...handles], ['Stored thread bodies only; full mailbox history and immutable snapshot are unverified.']),
    order: 'sentAt-asc_receivedAt-asc_createdAt-asc_nulls-and-ties-unspecified',
    messages, totalMessages: total, hasMoreMessages: hasMore,
    nextMessageOffset: nextOffset, nextBodyOffsets,
  };
}

/**
 * Returns a conservative Meri 0.2 page or refuses. A route must first authenticate
 * the user, verify the current task and selected subject, and call the existing
 * owner under that context. No legacy owner DTO is silently upgraded.
 */
export function projectMailRetainedSourceV02(input: MailRetainedProjectionInput): JsonObject {
  const {operation, ownerResult, readAt, requestId, traceId} = input;
  if (!['mail.list_messages', 'mail.search_messages', 'mail.read_thread'].includes(operation))
    refuse('operation');
  const {binding, subject, selection, scopes} = trustedTask(input.binding, input.subject, input.selection);
  const owner = json(object(ownerResult, 'owner_result'), 'owner_result');
  const stamp = instant(readAt, 'read_at');
  uuid(requestId, 'request_id'); uuid(traceId, 'trace_id');
  const projected = operation === 'mail.read_thread'
    ? threadPage(binding, subject, selection, owner, scopes, stamp, requestId, traceId)
    : candidatePage(operation, binding, subject, selection, owner, scopes, stamp, requestId, traceId);
  return json(projected, 'projection_result');
}
