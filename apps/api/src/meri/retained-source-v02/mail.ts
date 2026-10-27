/**
 * Pure preparation for Meri's mail 0.2 passive source pages. The caller must
 * supply a current, authorized Core owner read and its mailbox inventory. This
 * module neither opens a mailbox nor grants access to one. In particular, the
 * source owner must supply the row and mailbox lineage needed to select the
 * exact mailbox scopes in the verified Meri subject. Read handles are only
 * source selectors; their use requires a fresh authorized owner read.
 */
import { createHash } from 'node:crypto';
import { createMailBodySection, isWellFormedMailText as wellFormedUtf16, mailSurrogatePair as surrogatePair } from '../../engagement/mail-body-section.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import baseSchema from './mail-base.schema.json';
import commonSchema from './mail-common.schema.json';
import retrievalSchema from './mail-retrieval.schema.json';
import mailSchema from './mail.schema.json';

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
  /** Caller-observed time immediately after the owner read; not a sync timestamp. */
  readAt: string;
  requestId: string;
  traceId: string;
};

type JsonObject = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MILLISECOND_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
// Exact Meri PR158 @ 052f9865 schema bytes are pinned in mail.spec.ts.
// Compile the complete output shape, including referenced common, retrieval,
// and base contracts, before any projected page leaves this module.
const ajv = new Ajv2020({strict: true, allErrors: true});
addFormats(ajv);
for (const schema of [baseSchema, commonSchema, retrievalSchema, mailSchema])
  ajv.addSchema(schema);
const candidateShape = ajv.getSchema('urn:meri:retrieval:mail:0.2.0#/$defs/MailCandidateSourcePage');
const threadShape = ajv.getSchema('urn:meri:retrieval:mail:0.2.0#/$defs/MailThreadSourcePage');
if (!candidateShape || !threadShape) throw new Error('Meri mail 0.2 schema compilation failed');

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
function utcDateTime(value: unknown, reason: string): string {
  const result = string(value, reason);
  // Meri accepts RFC3339 spellings, including offsets and omitted milliseconds.
  // The owner normalizes the same instant for SQL; keep Meri's input spelling
  // in its exact query-scope echo. Submillisecond precision is not representable
  // by the current JavaScript/SQL owner and must fail closed.
  if (!MILLISECOND_DATE_TIME.test(result) || !Number.isFinite(Date.parse(result))) refuse(reason);
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
  if (scopes.some(scope => scope.tenantId !== binding.tenantId ||
      scope.policyRevision !== subject.policyRevision) || subject.rosterVersionId !== null)
    refuse('subject.scope_lineage');
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

function mailboxInventory(value: unknown, scopes: JsonObject[], binding: JsonObject) {
  const entries = array(value, 'mailbox_inventory');
  if (entries.length < 1 || entries.length > 4096) refuse('mailbox_inventory');
  const seen = new Set<string>(), statuses = new Map<string, string>();
  for (const entry of entries) {
    const box = object(entry, 'mailbox_inventory.entry');
    const proof = object(box.sourceProof, 'mailbox_inventory.source_proof');
    if (proof.version !== 1) refuse('mailbox_inventory.source_proof');
    const id = uuid(proof.mailboxId, 'mailbox_inventory.id');
    if (seen.has(id) || proof.ownerTenantId !== binding.tenantId ||
        proof.ownerActorId !== binding.actorId ||
        !scopes.some(scope => scope.kind === 'mailbox' && scope.resourceId === id &&
          scope.tenantId === binding.tenantId))
      refuse('mailbox_inventory.scope');
    seen.add(id);
    statuses.set(id, string(box.status, 'mailbox_inventory.status'));
  }
  return statuses;
}

function rowScopes(proof: JsonObject, subjectScopes: JsonObject[], binding: JsonObject, mailboxId: string) {
  if (proof.ownerTenantId !== binding.tenantId || proof.ownerActorId !== binding.actorId)
    refuse('message.owner_scope');
  const scopes = subjectScopes.filter(scope => scope.kind === 'mailbox' &&
    scope.tenantId === binding.tenantId && scope.resourceId === mailboxId);
  if (scopes.length !== 1) refuse('message.scopes');
  return scopes;
}

/** A version-bound database pointer, never an authorization or currentness token. */
export function mailRetainedReadHandleV02(
  mailboxId: unknown, threadId: unknown, messageId: unknown, messageUpdatedAt: unknown,
): string {
  const mailbox = uuid(mailboxId, 'read_handle.mailbox_id');
  const thread = uuid(threadId, 'read_handle.thread_id');
  const message = uuid(messageId, 'read_handle.message_id');
  const version = instant(messageUpdatedAt, 'read_handle.message_version');
  return `mail:v02:${mailbox}:${thread}:${message}:${version}`;
}

/** Mirrors Meri's scalar-safe UTF-16 section algorithm for the canonical owner mapper. */
export function createMailBodySectionV02(text: unknown, bodyOffset: unknown, maxCharacters: unknown) {
  if (typeof text !== 'string' || !wellFormedUtf16(text)) refuse('thread.body_text');
  const offset = integer(bodyOffset, 0, 10000000, 'thread.body_offset');
  const max = integer(maxCharacters, 1, 6000, 'thread.max_characters');
  return createMailBodySection(text, offset, max);
}

function assertMailBodySectionV02(text: string, start: number, end: number, total: number,
  requestedOffset: number, maxCharacters: number, hasMore: boolean) {
  if (end < start || end - start > maxCharacters + 1 ||
      text.length !== end - start || !wellFormedUtf16(text)) refuse('thread.utf16_window');
  const requestedStart = Math.min(requestedOffset, total);
  const requestedEnd = Math.min(total, requestedOffset + maxCharacters);
  const startMatches = start === requestedStart || start === requestedStart - 1 && surrogatePair(text, 0);
  const endMatches = end === requestedEnd ||
    end === requestedEnd - 1 && end > start && requestedEnd < total ||
    maxCharacters === 1 && end === requestedEnd + 1 && end <= total &&
      surrogatePair(text, text.length - 2);
  if (!startMatches || !endMatches || end > total || hasMore !== (end < total) ||
      start < total && end <= start) refuse('thread.utf16_window');
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
  const boxes = mailboxInventory(owner.searchedMailboxes, scopes, binding);
  const folder = selection.folder;
  if (!['all', 'inbox', 'sent'].includes(String(folder))) refuse('selection.folder');
  const limit = integer(selection.limit, 1, 50, 'selection.limit');
  const offset = integer(selection.offset, 0, 10000, 'selection.offset');
  const withinDays = selection.withinDays === null ? null :
    integer(selection.withinDays, 1, 3650, 'selection.withinDays');
  const asOf = selection.asOf === null ? null : utcDateTime(selection.asOf, 'selection.asOf');
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
  if (asOf !== null && Date.parse(anchor) !== Date.parse(asOf) ||
      Date.parse(anchor) > Date.parse(readAt) + 1000)
    refuse('owner.anchor');
  // Meri retains an explicit caller asOf string verbatim. The owner normalizes
  // that instant to ISO for SQL; preserve the caller's UTC spelling in q scope.
  const queryAnchor = asOf ?? anchor;
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
    const readHandle = mailRetainedReadHandleV02(mailboxId, threadId, messageId,
      proof.messageUpdatedAt);
    if (readHandle.length > 256 || handles.has(readHandle)) refuse('message.read_handle');
    handles.add(readHandle);
    const rowScope = rowScopes(proof, scopes, binding, mailboxId);
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
    const previous = messages[i - 1]!, current = messages[i]!;
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
    queryScope: {asOfInclusive: queryAnchor, storedCreatedAtEndInclusive: queryAnchor,
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
  const boxes = mailboxInventory(owner.mailboxInventory, scopes, binding);
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
  if (!boxes.has(mailboxId) || proof.mailboxStatus !== boxes.get(mailboxId) ||
      proof.ownerTenantId !== binding.tenantId || proof.ownerActorId !== binding.actorId)
    refuse('thread.mailbox_inventory');
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
    const readHandle = mailRetainedReadHandleV02(mailboxId, threadId, id,
      sourceProof.messageUpdatedAt);
    if (readHandle.length > 256 || handles.has(readHandle)) refuse('thread.read_handle');
    handles.add(readHandle);
    const rowScope = rowScopes(sourceProof, scopes, binding, mailboxId);
    if (row.bodyStoredPresent !== true || typeof row.bodyText !== 'string' ||
        !['full', 'preview', 'truncated', 'unknown'].includes(String(row.bodyCompleteness)))
      refuse('thread.utf16_evidence');
    const bodyText = row.bodyText as string;
    const start = integer(row.bodyOffset, 0, 10000000, 'thread.body_offset');
    const totalUnits = integer(row.bodyLength, 0, Number.MAX_SAFE_INTEGER, 'thread.body_length');
    const endExclusive = start + bodyText.length;
    const more = endExclusive < totalUnits;
    assertMailBodySectionV02(bodyText, start, endExclusive, totalUnits,
      bodyOffset, maxCharacters, more);
    if (endExclusive > 10006000 || row.bodyTruncated !== (start > 0 || more))
      refuse('thread.utf16_window');
    if (row.nextBodyOffset !== (more ? endExclusive : null)) refuse('thread.utf16_continuation');
    const contentSha256 = string(sourceProof.bodySha256, 'thread.body_hash');
    if (!SHA256.test(contentSha256) || start === 0 && !more && textHash(bodyText) !== contentSha256)
      refuse('thread.body_hash');
    const recordVersionId = sourceProof.messageUpdatedAt === null ? null :
      instant(sourceProof.messageUpdatedAt, 'thread.record_version');
    const section = {start, endExclusive, totalCodeUnits: totalUnits,
      unit: 'utf16-code-unit', text: bodyText, hasMore: more};
    // Optional proposal context is admitted only for an exact selected original.
    // The canonical sender reauthorizes it and its current bytes before claim.
    let nativeActions: unknown[] | undefined;
    if (messageId !== null && Array.isArray(row.nativeActions) && row.nativeActions.length) {
      const modes = new Set<string>();
      nativeActions = row.nativeActions.map(value => {
        const action = object(value, 'thread.native_action');
        const original = object(action.original, 'thread.native_original');
        const mode = string(action.mode, 'thread.native_mode');
        if (modes.has(mode) || action.senderConnectionId !== mailboxId ||
            original.threadId !== threadId || original.messageId !== id ||
            original.updatedAt !== recordVersionId || recordVersionId === null ||
            mode === 'forward' && (original.bodySha256 !== contentSha256 ||
              typeof action.originalBodyText !== 'string' || textHash(action.originalBodyText) !== contentSha256) ||
            mode !== 'forward' && original.bodySha256 !== null)
          refuse('thread.native_lineage');
        const recipients = [...array(action.to, 'thread.native_to'), ...array(action.cc, 'thread.native_cc')];
        if (new Set(recipients).size !== recipients.length ||
            mode === 'reply' && (array(action.to, 'thread.native_to').length !== 1 || array(action.cc, 'thread.native_cc').length !== 0) ||
            mode === 'reply_all' && array(action.to, 'thread.native_to').length === 0 ||
            mode === 'forward' && (recipients.length !== 0 || (action.originalBodyText as string).length > 6000) ||
            mode !== 'forward' && Object.hasOwn(action, 'originalBodyText')) refuse('thread.native_recipients');
        modes.add(mode); return action;
      });
    }

    messages.push({sourceId: 'mail', mailboxId, threadId, messageId: id,
      recordVersionId, citationId: null, contentSha256, scopes: rowScope,
      removed: false, connectionStatus: row.connectionStatus,
      bodyCompleteness: row.bodyCompleteness, readHandle, section,
      ...(nativeActions ? {nativeActions} : {})});
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
  const result = json(projected, 'projection_result');
  const outputShape = operation === 'mail.read_thread' ? threadShape : candidateShape;
  if (!outputShape) return refuse('output.schema');
  const valid = outputShape(result);
  if (!valid) refuse('output.schema');
  return result;
}
