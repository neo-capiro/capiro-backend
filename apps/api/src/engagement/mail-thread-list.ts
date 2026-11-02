import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { mailReadMessageWhere, normalizeMailReadFilters, normalizeMailReadRecipients,
  mailReadRecipientMatch, mailReadClientAssociation } from './mail-query.js';
import { requireMailReadScope } from './mail-thread-pages.js';
import { getMailSyncCoverage } from './mail-sync-coverage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new BadRequestException('Use a bounded mail page and its exact filters and continuation.');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface MailThreadListInput extends Record<string, unknown> {
  clientId?: string;
  recipientEmails?: string[];
}
interface Position { id: string; lastMessageAt: string | null; updatedAt: string }
interface ListRow {
  id: string; tenantId: string; clientId: string | null; connectionId: string;
  subject: string; snippet: string | null; participants: Prisma.JsonValue;
  createdAt: Date; updatedAt: Date; lastMessageAt: Date | null;
  connectionEmail: string | null; messages: Prisma.JsonValue;
  cursorUpdatedAt: string; cursorLastMessageAt: string | null;
}

function listPage(ctx: TenantContext, input: MailThreadListInput) {
  const limit = input.limit == null ? 50 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw invalid();
  const recipients = normalizeMailReadRecipients(input.recipientEmails);
  let decoded: Record<string, unknown> | undefined;
  if (input.cursor != null) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw invalid();
    try { decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
    catch { throw invalid(); }
    if (!decoded || Object.keys(decoded).sort().join(',') !== 'asOf,id,lastMessageAt,scope,updatedAt,v' || decoded.v !== 1) throw invalid();
  }
  const filters = normalizeMailReadFilters({ ...input, asOf: input.asOf ?? decoded?.asOf });
  if ('error' in filters) throw new BadRequestException(filters.error);
  const asOf = filters.asOf.toISOString();
  const scope = hash([ctx.tenantId, ctx.userId, filters.clientId, recipients, filters.query,
    filters.from, filters.participant, filters.folder, filters.withinDays, limit]);
  let position: Position | undefined;
  if (decoded) {
    const date = (value: unknown) => typeof value === 'string' && value.length <= 40 &&
      Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value);
    if (decoded.scope !== scope || decoded.asOf !== asOf || typeof decoded.id !== 'string' || !UUID.test(decoded.id) ||
        !date(decoded.updatedAt) || (decoded.lastMessageAt !== null && !date(decoded.lastMessageAt))) throw invalid();
    position = { id: decoded.id, updatedAt: decoded.updatedAt as string, lastMessageAt: decoded.lastMessageAt as string | null };
  }
  return { limit, recipients, filters, position, cursor: (row: ListRow) => Buffer.from(JSON.stringify({
    v: 1, scope, asOf, id: row.id, updatedAt: row.cursorUpdatedAt, lastMessageAt: row.cursorLastMessageAt,
  })).toString('base64url') };
}

function afterPosition(position?: Position) {
  if (!position) return Prisma.empty;
  const tail = Prisma.sql`(t.updated_at,t.id) < (${position.updatedAt}::timestamptz,${position.id}::uuid)`;
  return position.lastMessageAt === null
    ? Prisma.sql`AND t.last_message_at IS NULL AND ${tail}`
    : Prisma.sql`AND (t.last_message_at < ${position.lastMessageAt}::timestamptz OR t.last_message_at IS NULL OR
      (t.last_message_at = ${position.lastMessageAt}::timestamptz AND ${tail}))`;
}

/** The interactive mail page keeps its full budget; derived readers pass a smaller one. */
export const MAIL_THREAD_LIST_BUDGET_MS = 10_000;
export interface MailThreadListOptions {
  /** Server-side statement budget for the page read; the transaction gets 2 s more to unwind. */
  budgetMs?: number;
}

/** Live activity ordering: mutations may move an existing row. Clients dedupe IDs and explicitly refresh. */
export async function readMailThreadList(prisma: PrismaService, ctx: TenantContext, input: MailThreadListInput,
  profileEmails: (tx: Prisma.TransactionClient, clientId: string) => Promise<string[]>, options: MailThreadListOptions = {}) {
  const page = listPage(ctx, input);
  const budgetMs = options.budgetMs ?? MAIL_THREAD_LIST_BUDGET_MS;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 100 || budgetMs > MAIL_THREAD_LIST_BUDGET_MS) throw new RangeError('Invalid mail list budget');
  return prisma.withTenant(ctx.tenantId, async tx => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${budgetMs}ms`}, true)`;
    const { clientId, asOf } = page.filters;
    await requireMailReadScope(tx, ctx, clientId || undefined);
    const emails = clientId ? [...new Set([...(await profileEmails(tx, clientId)), ...page.recipients])] : [];
    const association = !clientId ? Prisma.empty : Prisma.sql`AND ${mailReadClientAssociation(clientId, emails, asOf)}`;
    const matching = mailReadMessageWhere(ctx, { ...page.filters, clientId: '' });
    const rows = await tx.$queryRaw<ListRow[]>(Prisma.sql`
      WITH selected AS MATERIALIZED (
        SELECT t.id FROM mail_threads t
        JOIN engagement_connections c ON c.id=t.connection_id AND c.tenant_id=t.tenant_id
        WHERE t.tenant_id=${ctx.tenantId}::uuid AND c.created_by_user_id=${ctx.userId}::uuid AND t.created_at <= ${asOf}
          AND EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id=t.id AND ${matching}
            ${page.recipients.length ? Prisma.sql`AND ${mailReadRecipientMatch('m', page.recipients)}` : Prisma.empty})
          ${association} ${afterPosition(page.position)}
        ORDER BY t.last_message_at DESC NULLS LAST,t.updated_at DESC,t.id DESC LIMIT ${page.limit + 1}
      )
      SELECT t.id::text AS id,t.tenant_id::text AS "tenantId",t.client_id::text AS "clientId",
        t.connection_id::text AS "connectionId",t.subject,left(t.snippet,400) AS snippet,
        jsonb_path_query_array(t.participants_jsonb,'$[0 to 7]') AS participants,
        t.created_at AS "createdAt",t.updated_at AS "updatedAt",t.last_message_at AS "lastMessageAt",
        to_char(t.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorUpdatedAt",
        to_char(t.last_message_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorLastMessageAt",
        c.account_email::text AS "connectionEmail",
        COALESCE(preview.messages,'[]'::jsonb) AS messages
      FROM selected JOIN mail_threads t ON t.id=selected.id
      JOIN engagement_connections c ON c.id=t.connection_id AND c.tenant_id=t.tenant_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',p.id,'threadId',p.thread_id,'subject',p.subject,
          'fromEmail',p.from_email,'fromName',p.from_name,'toRecipients',jsonb_path_query_array(p.to_recipients_jsonb,'$[0 to 7]'),
          'ccRecipients',jsonb_path_query_array(p.cc_recipients_jsonb,'$[0 to 7]'),'bodyText',left(p.body_text,400),
          'bodyTruncated',length(p.body_text)>400,'sentAt',p.sent_at,'receivedAt',p.received_at,'createdAt',p.created_at)
          ORDER BY p.received_at DESC,p.sent_at DESC,p.created_at DESC,p.id DESC) AS messages
        FROM (SELECT m.* FROM mail_messages m WHERE m.tenant_id=t.tenant_id AND m.thread_id=t.id
          AND m.connection_id=t.connection_id AND m.removed_at IS NULL AND m.created_at <= ${asOf}
          ORDER BY m.received_at DESC,m.sent_at DESC,m.created_at DESC,m.id DESC LIMIT 3) p
      ) preview ON true
      ORDER BY t.last_message_at DESC NULLS LAST,t.updated_at DESC,t.id DESC
    `);
    const boxes = await tx.integrationConnection.findMany({ where: { tenantId: ctx.tenantId, createdByUserId: ctx.userId,
      provider: { in: ['microsoft_365', 'google_workspace'] } }, orderBy: { id: 'asc' }, take: 51,
      select: { id: true, accountEmail: true, provider: true, status: true, lastSyncAt: true, syncState: true } });
    const selected = rows.slice(0, page.limit), hasMore = rows.length > page.limit;
    const nextCursor = hasMore ? page.cursor(selected[selected.length - 1]!) : null;
    const items = selected.map(({ cursorUpdatedAt: _updated, cursorLastMessageAt: _last, ...row }) => row);
    return { items, hasMore, nextCursor,
      asOf: asOf.toISOString(), coverageTruncated: boxes.length > 50,
      mailboxes: boxes.slice(0, 50).map(box => ({ id: box.id, email: box.accountEmail, coverage: getMailSyncCoverage(box) })),
      notice: 'Stored active mail with live activity ordering. New sync or edits can move threads between pages; refresh to restart and deduplicate repeated IDs. Previews and mailbox coverage are bounded, not all provider history.',
    };
  }, { readOnly: true, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeoutMs: budgetMs + 2_000 });
}
