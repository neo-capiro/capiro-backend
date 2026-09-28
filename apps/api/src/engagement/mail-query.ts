import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { getMailSyncCoverage } from './mail-sync-coverage.js';

const MAIL_PROVIDERS = ['microsoft_365', 'google_workspace'];

type MailRow = {
  id: string;
  thread_id: string;
  connection_id: string;
  message_updated_at: Date;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  to_recipients: unknown;
  cc_recipients: unknown;
  sent_at: Date | null;
  received_at: Date | null;
  preview: string | null;
  has_attachments: boolean;
  folder: string | null;
  internet_message_id: string | null;
  client_id: string | null;
  client_name: string | null;
  account_email: string | null;
};

/** Canonical bounded reads of the caller's synced mail. Interpretation stays with the provider. */
export async function queryMailMessages(
  prisma: PrismaService,
  ctx: TenantContext,
  input: Record<string, unknown>,
  options: { allowUnfiltered?: boolean; defaultLimit?: number } = {},
) {
  const term = (key: string, max = 200) =>
    typeof input[key] === 'string' ? (input[key] as string).trim().slice(0, max) : '';
  const query = term('query');
  const from = term('from');
  const participant = term('participant');
  const clientId = term('clientId', 200);
  const folder = term('folder') || 'all';
  const withinDays = input.withinDays == null ? null : Number(input.withinDays);
  const limit = input.limit == null ? (options.defaultLimit ?? 20) : Number(input.limit);
  const offset = input.offset == null ? 0 : Number(input.offset);
  const asOf = input.asOf == null ? new Date() : new Date(String(input.asOf));
  if (
    clientId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
  ) {
    return { error: 'clientId must be a client UUID — pass the exact id, or omit it.' };
  }
  if (!['all', 'inbox', 'sent'].includes(folder)) {
    return { error: 'folder must be inbox, sent, or all.' };
  }
  if (
    withinDays !== null &&
    (!Number.isInteger(withinDays) || withinDays < 1 || withinDays > 3650)
  ) {
    return { error: 'withinDays must be an integer from 1 through 3650.' };
  }
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10000
  ) {
    return { error: 'limit must be 1–50 and offset must be 0–10000.' };
  }
  if (
    !Number.isFinite(asOf.getTime()) ||
    asOf.getTime() > Date.now() + 1000 ||
    (offset > 0 && !input.asOf)
  ) {
    return {
      error:
        'Use a valid, non-future asOf timestamp; continuation pages must reuse the first page’s asOf.',
    };
  }
  if (
    !options.allowUnfiltered &&
    !query &&
    !from &&
    !participant &&
    withinDays === null &&
    folder === 'all'
  ) {
    return {
      error:
        "Provide at least one of 'query', 'from', or 'participant', or a withinDays/folder filter. Use list_emails for newest mail.",
    };
  }
  const windowStart = withinDays === null ? null : new Date(asOf.getTime() - withinDays * 86400000);
  const pattern = (value: string) => `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  // The same tenant + connection-owner boundary as engagement-access.helpers.
  // Raw SQL is needed for literal fragment matching inside recipient JSON arrays.
  const conds: Prisma.Sql[] = [
    Prisma.sql`m.tenant_id = ${ctx.tenantId}::uuid`,
    Prisma.sql`c.tenant_id = m.tenant_id`,
    Prisma.sql`t.tenant_id = m.tenant_id`,
    Prisma.sql`t.connection_id = m.connection_id`,
    Prisma.sql`c.created_by_user_id = ${ctx.userId}::uuid`,
    Prisma.sql`c.provider::text IN (${Prisma.join(MAIL_PROVIDERS)})`,
    Prisma.sql`m.removed_at IS NULL`,
    Prisma.sql`m.created_at <= ${asOf}`,
    Prisma.sql`(COALESCE(m.received_at, m.sent_at) <= ${asOf} OR COALESCE(m.received_at, m.sent_at) IS NULL)`,
  ];
  if (query) {
    const p = pattern(query);
    conds.push(
      Prisma.sql`(m.subject ILIKE ${p} OR m.body_text ILIKE ${p} OR m.from_email::text ILIKE ${p} OR m.from_name ILIKE ${p} OR m.to_recipients_jsonb::text ILIKE ${p} OR m.cc_recipients_jsonb::text ILIKE ${p})`,
    );
  }
  if (from) {
    const p = pattern(from);
    conds.push(Prisma.sql`(m.from_email::text ILIKE ${p} OR m.from_name ILIKE ${p})`);
  }
  if (participant) {
    const p = pattern(participant);
    conds.push(
      Prisma.sql`(m.from_email::text ILIKE ${p} OR m.from_name ILIKE ${p} OR m.to_recipients_jsonb::text ILIKE ${p} OR m.cc_recipients_jsonb::text ILIKE ${p} OR m.bcc_recipients_jsonb::text ILIKE ${p})`,
    );
  }
  if (clientId) conds.push(Prisma.sql`t.client_id = ${clientId}::uuid`);
  if (windowStart) conds.push(Prisma.sql`COALESCE(m.received_at, m.sent_at) >= ${windowStart}`);
  if (folder === 'inbox') conds.push(Prisma.sql`lower(m.metadata_jsonb->>'folder') = 'inbox'`);
  if (folder === 'sent')
    conds.push(Prisma.sql`lower(m.metadata_jsonb->>'folder') IN ('sent', 'sentitems')`);
  const where = Prisma.join(conds, ' AND ');
  const { total, rows, coverage } = await prisma.withTenant(ctx.tenantId, async (tx) => {
    const counted = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(DISTINCT (m.connection_id, COALESCE(NULLIF(m.metadata_jsonb->>'internetMessageId', ''), m.id::text)))::int AS n
      FROM mail_messages m
      JOIN engagement_connections c ON c.id = m.connection_id
      JOIN mail_threads t ON t.id = m.thread_id
      WHERE ${where}
    `);
    // Deduplicate BEFORE paginating: folder copies cannot consume the page or
    // hide later distinct messages. Keep copies in different owned mailboxes.
    const rows = await tx.$queryRaw<MailRow[]>(Prisma.sql`
      SELECT * FROM (
        SELECT DISTINCT ON (m.connection_id, COALESCE(NULLIF(m.metadata_jsonb->>'internetMessageId', ''), m.id::text))
          m.id::text AS id, m.thread_id::text AS thread_id,
          m.connection_id::text AS connection_id, m.updated_at AS message_updated_at, m.subject,
          m.from_email::text AS from_email, m.from_name,
          m.to_recipients_jsonb AS to_recipients, m.cc_recipients_jsonb AS cc_recipients,
          m.sent_at, m.received_at, left(m.body_text, 400) AS preview, m.has_attachments,
          m.metadata_jsonb->>'folder' AS folder,
          m.metadata_jsonb->>'internetMessageId' AS internet_message_id,
          t.client_id::text AS client_id, cl.name AS client_name, c.account_email::text AS account_email
        FROM mail_messages m
        JOIN engagement_connections c ON c.id = m.connection_id
        JOIN mail_threads t ON t.id = m.thread_id
        LEFT JOIN clients cl ON cl.id = t.client_id AND cl.tenant_id = m.tenant_id
        WHERE ${where}
        ORDER BY m.connection_id, COALESCE(NULLIF(m.metadata_jsonb->>'internetMessageId', ''), m.id::text),
                 COALESCE(m.received_at, m.sent_at) DESC NULLS LAST, m.id DESC
      ) distinct_messages
      ORDER BY COALESCE(received_at, sent_at) DESC NULLS LAST, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const coverage = await tx.$queryRaw<
      Array<{
        account_email: string | null;
        connection_id: string;
        provider: string;
        status: string;
        last_sync_at: Date | null;
        sync_state: unknown;
        synced_messages: number;
        oldest_synced: Date | null;
        newest_synced: Date | null;
      }>
    >(Prisma.sql`
      SELECT c.account_email::text AS account_email, c.id::text AS connection_id,
             c.provider::text AS provider,
             c.status::text AS status, c.last_sync_at, c.sync_state_jsonb AS sync_state,
             count(m.id)::int AS synced_messages,
             min(COALESCE(m.received_at, m.sent_at)) AS oldest_synced,
             max(COALESCE(m.received_at, m.sent_at)) AS newest_synced
      FROM engagement_connections c
      LEFT JOIN mail_messages m ON m.connection_id = c.id AND m.tenant_id = c.tenant_id AND m.removed_at IS NULL
      WHERE c.tenant_id = ${ctx.tenantId}::uuid AND c.created_by_user_id = ${ctx.userId}::uuid
            AND c.provider::text IN (${Prisma.join(MAIL_PROVIDERS)})
      GROUP BY c.id, c.created_at ORDER BY c.created_at
    `);
    return { total: counted[0]?.n ?? 0, rows, coverage };
  });
  const searchedMailboxes = coverage.map((c) => {
    const mailCoverage = getMailSyncCoverage({
      provider: c.provider,
      status: c.status,
      lastSyncAt: c.last_sync_at,
      syncState: c.sync_state,
    });
    return {
      accountEmail: c.account_email,
      sourceProof: { version: 1, mailboxId: c.connection_id },
      provider: c.provider,
      status: c.status,
      lastSyncAt: mailCoverage.lastMailSyncAt,
      connectionLastSyncAt: mailCoverage.lastConnectionSyncAt,
      syncedMessages: c.synced_messages,
      syncedRange:
        c.synced_messages > 0 ? { oldest: c.oldest_synced, newest: c.newest_synced } : null,
      mailCoverage,
    };
  });
  const capRecipients = (value: unknown) =>
    (Array.isArray(value) ? value : []).slice(0, 8).map((r) => ({
      email: typeof r?.email === 'string' ? r.email : null,
      name: typeof r?.name === 'string' ? r.name : null,
    }));
  const messages = rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    subject: row.subject,
    from: { email: row.from_email, name: row.from_name },
    to: capRecipients(row.to_recipients),
    cc: capRecipients(row.cc_recipients),
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    folder: row.folder,
    preview: row.preview,
    hasAttachments: row.has_attachments,
    mailbox: row.account_email,
    client: row.client_id ? { id: row.client_id, name: row.client_name } : null,
    sourceProof: {
      version: 1,
      mailboxId: row.connection_id,
      threadId: row.thread_id,
      messageId: row.id,
      messageUpdatedAt: row.message_updated_at.toISOString(),
      previewSha256: createHash('sha256').update(row.preview ?? '', 'utf8').digest('hex'),
    },
  }));
  const hasMore = offset + messages.length < total;
  const nextOffset =
    hasMore && messages.length > 0 && offset + messages.length <= 10000
      ? offset + messages.length
      : null;
  const notes = [
    'Results cover stored, active mail only. Junk/spam, deleted/trash, and drafts are excluded from sync. Message previews here are abbreviated; use get_email_thread with threadId to read stored bodies and their completeness before inferring commitments beyond a preview.',
    'A connection timestamp or the oldest/newest stored message does not establish complete mailbox coverage. Use each mailbox’s mailCoverage before making absence claims.',
    'Initial and recovery sync scan a bounded 365-day window. Older stored mail may remain, but older periods cannot be assumed fully covered.',
  ];
  if (!searchedMailboxes.length)
    notes.push(
      'No connected mailbox exists for this user — nothing was searched. Connect Microsoft 365 or Google under Settings → Integrations.',
    );
  for (const box of searchedMailboxes) {
    if (!box.syncedMessages)
      notes.push(
        `Mailbox ${box.accountEmail ?? '(no address on record)'} (${box.provider}, status: ${box.status}) has NO synced mail — no inbox activity can be established from this empty store.`,
      );
    if (box.mailCoverage.sourceStatus !== 'healthy')
      notes.push(
        `Mailbox ${box.accountEmail ?? '(no address on record)'} has incomplete mail coverage: ${box.mailCoverage.reason}.`,
      );
  }
  if (hasMore)
    notes.push(
      nextOffset === null
        ? 'The bounded paging limit was reached; this is a partial view.'
        : 'More matching messages remain. Continue with nextOffset and the same asOf and filters before describing the complete period.',
    );
  return {
    totalMatches: total,
    returned: messages.length,
    hasMore,
    offset,
    nextOffset,
    asOf: asOf.toISOString(),
    queryScope: {
      query: query || null,
      from: from || null,
      participant: participant || null,
      clientId: clientId || null,
      folder,
      withinDays,
      asOf: asOf.toISOString(),
    },
    timeWindow: { start: windowStart?.toISOString() ?? null, end: asOf.toISOString() },
    folder,
    clientId: clientId || null,
    messages,
    searchedMailboxes,
    notes,
  };
}
