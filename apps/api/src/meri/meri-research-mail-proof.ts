import { createHash } from 'node:crypto';
import { researchJsonSha256 } from './meri-research-durable-result.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAIL_SEARCH_TOOLS = new Set(['list_emails', 'search_emails']);

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function records(value: unknown): UnknownRecord[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(record);
  return values.every((item): item is UnknownRecord => Boolean(item)) ? values : null;
}

function stringOrNull(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validDateOrNull(value: unknown): value is string | null {
  return value === null || validDate(value);
}

function rawTextSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function mailSearchProof(tool: string, value: unknown): string[] | null {
  const root = record(value);
  const messages = records(root?.messages);
  const mailboxes = records(root?.searchedMailboxes);
  const queryScope = record(root?.queryScope);
  const timeWindow = record(root?.timeWindow);
  const notes = root && Array.isArray(root.notes) ? root.notes : null;
  const offset = root?.offset === undefined ? 0 : root.offset;
  if (
    !root ||
    !messages ||
    !mailboxes ||
    !queryScope ||
    !timeWindow ||
    !notes ||
    !notes.every((note) => typeof note === 'string') ||
    !Number.isSafeInteger(root.totalMatches) ||
    !Number.isSafeInteger(root.returned) ||
    root.totalMatches !== root.returned ||
    root.returned !== messages.length ||
    root.hasMore !== false ||
    offset !== 0 ||
    root.nextOffset !== null ||
    !validDate(root.asOf) ||
    queryScope.asOf !== root.asOf ||
    timeWindow.end !== root.asOf ||
    !(timeWindow.start === null || validDate(timeWindow.start)) ||
    stringOrNull(queryScope.query) === undefined ||
    stringOrNull(queryScope.from) === undefined ||
    stringOrNull(queryScope.participant) === undefined ||
    stringOrNull(queryScope.clientId) === undefined ||
    typeof queryScope.folder !== 'string' ||
    !(
      queryScope.withinDays === null ||
      (Number.isSafeInteger(queryScope.withinDays) && Number(queryScope.withinDays) > 0)
    ) ||
    root.folder !== queryScope.folder ||
    root.clientId !== queryScope.clientId ||
    mailboxes.length === 0
  ) {
    return null;
  }

  const mailboxById = new Map<string, UnknownRecord>();
  const mailboxProof = [];
  for (const mailbox of mailboxes) {
    const sourceProof = record(mailbox.sourceProof);
    const coverage = record(mailbox.mailCoverage);
    const syncedRange = mailbox.syncedRange === null ? null : record(mailbox.syncedRange);
    const mailboxId = sourceProof?.mailboxId;
    if (
      sourceProof?.version !== 1 ||
      typeof mailboxId !== 'string' ||
      mailboxId.length === 0 ||
      mailboxById.has(mailboxId) ||
      stringOrNull(mailbox.accountEmail) === undefined ||
      typeof mailbox.provider !== 'string' ||
      mailbox.status !== 'connected' ||
      !validDateOrNull(mailbox.lastSyncAt) ||
      !validDateOrNull(mailbox.connectionLastSyncAt) ||
      !Number.isSafeInteger(mailbox.syncedMessages) ||
      Number(mailbox.syncedMessages) < 0 ||
      (Number(mailbox.syncedMessages) === 0 && syncedRange !== null) ||
      (Number(mailbox.syncedMessages) > 0 &&
        (!syncedRange ||
          !validDateOrNull(syncedRange.oldest) ||
          !validDateOrNull(syncedRange.newest))) ||
      !coverage ||
      coverage.sourceStatus !== 'healthy' ||
      coverage.reason !== null ||
      !validDateOrNull(coverage.lastMailSyncAt) ||
      !validDateOrNull(coverage.lastConnectionSyncAt) ||
      coverage.backfillComplete !== true ||
      coverage.hasMore !== false ||
      coverage.captureRepair !== 'complete'
    ) {
      return null;
    }
    mailboxById.set(mailboxId, mailbox);
    mailboxProof.push({
      mailboxId,
      accountEmail: mailbox.accountEmail,
      provider: mailbox.provider,
      status: mailbox.status,
      lastSyncAt: mailbox.lastSyncAt,
      connectionLastSyncAt: mailbox.connectionLastSyncAt,
      syncedMessages: mailbox.syncedMessages,
      syncedRange,
      sourceStatus: coverage.sourceStatus,
      reason: coverage.reason,
      lastMailSyncAt: coverage.lastMailSyncAt,
      lastConnectionSyncAt: coverage.lastConnectionSyncAt,
      backfillComplete: coverage.backfillComplete,
      hasMore: coverage.hasMore,
      captureRepair: coverage.captureRepair,
    });
  }

  const messageIds = new Set<string>();
  const messageProof = [];
  for (const message of messages) {
    const sourceProof = record(message.sourceProof);
    const from = record(message.from);
    const to = records(message.to);
    const cc = records(message.cc);
    const client = message.client === null ? null : record(message.client);
    const preview = stringOrNull(message.preview);
    const mailboxId = sourceProof?.mailboxId;
    const mailbox = typeof mailboxId === 'string' ? mailboxById.get(mailboxId) : null;
    if (
      sourceProof?.version !== 1 ||
      typeof message.id !== 'string' ||
      typeof message.threadId !== 'string' ||
      sourceProof.messageId !== message.id ||
      sourceProof.threadId !== message.threadId ||
      typeof mailboxId !== 'string' ||
      !mailbox ||
      sourceProof.previewSha256 !== rawTextSha256(preview ?? '') ||
      !SHA256_RE.test(String(sourceProof.previewSha256)) ||
      !validDate(sourceProof.messageUpdatedAt) ||
      messageIds.has(message.id) ||
      preview === undefined ||
      stringOrNull(message.subject) === undefined ||
      !validDateOrNull(message.sentAt) ||
      !validDateOrNull(message.receivedAt) ||
      !from ||
      stringOrNull(from.email) === undefined ||
      stringOrNull(from.name) === undefined ||
      !to ||
      !cc ||
      typeof message.hasAttachments !== 'boolean' ||
      stringOrNull(message.folder) === undefined ||
      message.mailbox !== mailbox.accountEmail ||
      (client !== null && (typeof client.id !== 'string' || stringOrNull(client.name) === undefined)) ||
      (queryScope.clientId !== null && client?.id !== queryScope.clientId)
    ) {
      return null;
    }
    messageIds.add(message.id);
    messageProof.push({
      id: message.id,
      threadId: message.threadId,
      subject: message.subject,
      from,
      to,
      cc,
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      folder: message.folder,
      preview,
      hasAttachments: message.hasAttachments,
      mailbox: message.mailbox,
      client,
      sourceProof: {
        mailboxId,
        messageUpdatedAt: sourceProof.messageUpdatedAt,
        previewSha256: sourceProof.previewSha256,
      },
    });
  }

  let threadProof: unknown = null;
  if (tool === 'list_emails') {
    const threads = records(root.threads);
    if (!threads || !Number.isSafeInteger(root.count) || root.count !== threads.length) return null;
    const seen = new Set<string>();
    const projected = [];
    for (const thread of threads) {
      const nested = records(thread.messages);
      if (
        typeof thread.id !== 'string' ||
        seen.has(thread.id) ||
        !nested ||
        stringOrNull(thread.subject) === undefined ||
        stringOrNull(thread.snippet) === undefined
      ) {
        return null;
      }
      const sourceRows = messages.filter((message) => message.threadId === thread.id);
      if (sourceRows.length !== nested.length || sourceRows.length === 0) return null;
      for (const [index, nestedMessage] of nested.entries()) {
        const sourceMessage = sourceRows[index]!;
        const sourceFrom = record(sourceMessage.from);
        if (
          nestedMessage.id !== sourceMessage.id ||
          nestedMessage.subject !== sourceMessage.subject ||
          nestedMessage.fromEmail !== sourceFrom?.email ||
          nestedMessage.fromName !== sourceFrom?.name ||
          nestedMessage.bodyText !== sourceMessage.preview ||
          nestedMessage.sentAt !== sourceMessage.sentAt ||
          nestedMessage.receivedAt !== sourceMessage.receivedAt
        ) {
          return null;
        }
      }
      seen.add(thread.id);
      projected.push({
        id: thread.id,
        subject: thread.subject,
        snippet: thread.snippet,
        messages: nested.map((message) => ({
          id: message.id,
          subject: message.subject,
          fromEmail: message.fromEmail,
          fromName: message.fromName,
          bodyText: message.bodyText,
          sentAt: message.sentAt,
          receivedAt: message.receivedAt,
        })),
      });
    }
    threadProof = projected;
  }

  return [
    researchJsonSha256({
      version: 1,
      owner: 'canonical_mail_search',
      tool,
      totalMatches: root.totalMatches,
      returned: root.returned,
      asOf: root.asOf,
      queryScope: {
        query: queryScope.query,
        from: queryScope.from,
        participant: queryScope.participant,
        clientId: queryScope.clientId,
        folder: queryScope.folder,
        withinDays: queryScope.withinDays,
        asOf: queryScope.asOf,
      },
      timeWindow: { start: timeWindow.start, end: timeWindow.end },
      mailboxes: mailboxProof.sort((left, right) => left.mailboxId.localeCompare(right.mailboxId)),
      messages: messageProof,
      threads: threadProof,
      notes,
    }),
  ];
}

function mailThreadProof(value: unknown): string[] | null {
  const root = record(value);
  const rootProof = record(root?.sourceProof);
  const messages = records(root?.messages);
  if (
    !root ||
    !rootProof ||
    !messages ||
    rootProof.version !== 1 ||
    typeof root.threadId !== 'string' ||
    rootProof.threadId !== root.threadId ||
    typeof rootProof.mailboxId !== 'string' ||
    rootProof.mailboxId.length === 0 ||
    rootProof.mailboxStatus !== 'connected' ||
    stringOrNull(rootProof.clientId) === undefined ||
    !validDate(rootProof.threadUpdatedAt) ||
    stringOrNull(root.subject) === undefined ||
    stringOrNull(root.mailbox) === undefined ||
    stringOrNull(root.messageId) === undefined ||
    root.messageOffset !== 0 ||
    !Number.isSafeInteger(root.totalMessages) ||
    !Number.isSafeInteger(root.returned) ||
    Number(root.totalMessages) <= 0 ||
    root.totalMessages !== root.returned ||
    root.returned !== messages.length ||
    root.hasMore !== false ||
    root.nextMessageOffset !== null
  ) {
    return null;
  }

  const ids = new Set<string>();
  const messageProof = [];
  for (const message of messages) {
    const sourceProof = record(message.sourceProof);
    const from = record(message.from);
    const to = Array.isArray(message.to) ? message.to : null;
    const cc = Array.isArray(message.cc) ? message.cc : null;
    if (
      sourceProof?.version !== 1 ||
      typeof message.id !== 'string' ||
      message.threadId !== root.threadId ||
      sourceProof.messageId !== message.id ||
      sourceProof.threadId !== root.threadId ||
      sourceProof.mailboxId !== rootProof.mailboxId ||
      !validDate(sourceProof.messageUpdatedAt) ||
      typeof message.bodyText !== 'string' ||
      !Number.isSafeInteger(message.bodyLength) ||
      message.bodyLength !== message.bodyText.length ||
      message.bodyOffset !== 0 ||
      message.bodyCompleteness !== 'full' ||
      message.bodyTruncated !== false ||
      message.nextBodyOffset !== null ||
      !SHA256_RE.test(String(sourceProof.bodySha256)) ||
      sourceProof.bodySha256 !== rawTextSha256(message.bodyText) ||
      (root.messageId !== null && root.messageId !== message.id) ||
      ids.has(message.id) ||
      stringOrNull(message.subject) === undefined ||
      !validDateOrNull(message.sentAt) ||
      !validDateOrNull(message.receivedAt) ||
      !from ||
      stringOrNull(from.email) === undefined ||
      stringOrNull(from.name) === undefined ||
      !to ||
      !cc
    ) {
      return null;
    }
    ids.add(message.id);
    messageProof.push({
      id: message.id,
      threadId: message.threadId,
      subject: message.subject,
      from,
      to,
      cc,
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      bodyText: message.bodyText,
      bodyLength: message.bodyLength,
      bodyCompleteness: message.bodyCompleteness,
      sourceProof: {
        messageUpdatedAt: sourceProof.messageUpdatedAt,
        bodySha256: sourceProof.bodySha256,
      },
    });
  }
  if (root.messageId !== null && messages.length !== 1) return null;

  return [
    researchJsonSha256({
      version: 1,
      owner: 'canonical_mail_thread',
      threadId: root.threadId,
      subject: root.subject,
      mailbox: root.mailbox,
      messageId: root.messageId,
      sourceProof: {
        mailboxId: rootProof.mailboxId,
        clientId: rootProof.clientId,
        threadUpdatedAt: rootProof.threadUpdatedAt,
      },
      messages: messageProof,
    }),
  ];
}

/**
 * Project only canonical, owner-produced mail evidence. The projection requires
 * healthy complete coverage and verifies each server-produced body/preview hash
 * against the bytes in the same result before it can authorize durable replay.
 */
export function canonicalMailOwnerProof(tool: string, value: unknown): string[] | null {
  if (!MAIL_SEARCH_TOOLS.has(tool) && tool !== 'get_email_thread') return null;
  return MAIL_SEARCH_TOOLS.has(tool) ? mailSearchProof(tool, value) : mailThreadProof(value);
}

export interface CanonicalMailReauthorization {
  executeInput: Record<string, unknown>;
  requestedClientId: string | null;
  returnedClientIds: string[];
}

function inputTerm(input: Record<string, unknown>, key: string, max = 200): string {
  return typeof input[key] === 'string' ? input[key].trim().slice(0, max) : '';
}

/**
 * Bind a durable mail result to the exact logical call that produced it. For a
 * search whose original call omitted asOf, the canonical server result owns the
 * timestamp used only for the current authorization re-read; the durable input
 * and its hash remain unchanged.
 */
export function canonicalMailReauthorization(
  tool: string,
  input: Record<string, unknown>,
  savedResult: unknown,
): CanonicalMailReauthorization | null {
  if (!canonicalMailOwnerProof(tool, savedResult)) return null;
  const root = record(savedResult)!;

  if (MAIL_SEARCH_TOOLS.has(tool)) {
    const queryScope = record(root.queryScope)!;
    const messages = records(root.messages)!;
    const query = inputTerm(input, 'query') || null;
    const from = inputTerm(input, 'from') || null;
    const participant = inputTerm(input, 'participant') || null;
    const requestedClientId = inputTerm(input, 'clientId') || null;
    const folder = inputTerm(input, 'folder') || 'all';
    const withinDays = input.withinDays == null ? null : Number(input.withinDays);
    const offset = input.offset == null ? 0 : Number(input.offset);
    const explicitAsOf = input.asOf == null ? null : new Date(String(input.asOf));
    if (
      queryScope.query !== query ||
      queryScope.from !== from ||
      queryScope.participant !== participant ||
      queryScope.clientId !== requestedClientId ||
      queryScope.folder !== folder ||
      queryScope.withinDays !== withinDays ||
      root.offset !== offset ||
      (explicitAsOf &&
        (!Number.isFinite(explicitAsOf.getTime()) || explicitAsOf.toISOString() !== root.asOf))
    ) {
      return null;
    }
    const returnedClientIds = [
      ...new Set(
        messages.flatMap((message) => {
          const client = message.client === null ? null : record(message.client);
          return typeof client?.id === 'string' ? [client.id] : [];
        }),
      ),
    ].sort();
    return {
      executeInput: explicitAsOf ? input : { ...input, asOf: root.asOf },
      requestedClientId,
      returnedClientIds,
    };
  }

  if (tool !== 'get_email_thread') return null;
  const proof = record(root.sourceProof)!;
  const threadId = inputTerm(input, 'threadId');
  const messageId = inputTerm(input, 'messageId') || null;
  const requestedClientId = inputTerm(input, 'clientId') || null;
  const messageOffset = input.messageOffset == null ? 0 : Number(input.messageOffset);
  const bodyOffset = input.bodyOffset == null ? 0 : Number(input.bodyOffset);
  const returnedClientId = typeof proof.clientId === 'string' ? proof.clientId : null;
  if (
    threadId !== root.threadId ||
    messageId !== root.messageId ||
    messageOffset !== root.messageOffset ||
    bodyOffset !== 0 ||
    (requestedClientId !== null && requestedClientId !== returnedClientId)
  ) {
    return null;
  }
  return {
    executeInput: input,
    requestedClientId,
    returnedClientIds: returnedClientId ? [returnedClientId] : [],
  };
}
