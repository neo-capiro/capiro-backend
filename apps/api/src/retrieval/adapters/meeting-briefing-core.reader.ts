import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  canReadEncryptedEntry,
  ownMeetingWhere,
  ownMailThreadWhere,
  ownMailMessageWhere,
} from '../../engagement/engagement-access.helpers.js';
import type { MeetingNotesCryptoService } from '../../engagement/meeting-notes-crypto.service.js';
import { getMailSyncCoverage } from '../../engagement/mail-sync-coverage.js';
import type {
  RetrievalRecord,
  RetrievalRequest,
  RetrievalSourceStatus,
} from '../retrieval-v2.types.js';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';

export interface BriefingPage {
  records: RetrievalRecord[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
  degradedReason?: string;
  sourceStatus?: RetrievalSourceStatus;
  lastSyncAt?: Date;
}
const object = (value: unknown) => JSON.parse(JSON.stringify(value)) as KnowledgeJsonObject;
const terminal = ['done', 'canceled'] as const;

/** Runs inside the shared Retrieval V2 adapter, after its current client ACL check. */
export async function readMeetingBriefingCore(
  domain: 'meetings' | 'mail' | 'tasks',
  tx: Prisma.TransactionClient,
  request: RetrievalRequest,
  clientIds: string[],
  crypto?: MeetingNotesCryptoService,
  cursor?: string,
): Promise<BriefingPage> {
  const policy = request.meetingBriefing!;
  const clientScope =
    policy.scope === 'internal' ? { clientId: null } : { clientId: { in: clientIds } };
  const tenantId = request.caller.tenantId;
  const userId = request.caller.userId;
  // Internal meetings never turn their ambient authorized-client set into a
  // portfolio search. Explicit lexical focus narrows the actor-owned null-client set.
  const terms =
    policy.scope === 'internal'
      ? [
          ...new Set(
            (request.query ?? '').split(/[^\p{L}\p{N}@.-]+/u).filter((word) => word.length > 3),
          ),
        ].slice(0, 12)
      : [];
  const lexical = (field: string) =>
    terms.length
      ? { OR: terms.map((term) => ({ [field]: { contains: term, mode: 'insensitive' } })) }
      : {};
  if (domain === 'meetings') {
    const base: Prisma.MeetingWhereInput = {
      AND: [
        { tenantId, ...clientScope, id: { not: policy.meetingId }, ...lexical('subject') },
        ownMeetingWhere(userId),
      ],
    };
    const [past, upcoming, membership] = await Promise.all([
      tx.meeting.findMany({
        where: { AND: [base, { startsAt: { gte: policy.meetingSince, lt: policy.asOf } }] },
        orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
        take: policy.meetingLimit + 1,
        include: {
          notes: { orderBy: { createdAt: 'desc' }, take: 51 },
          debriefs: { orderBy: { createdAt: 'desc' }, take: 51 },
        },
      }),
      tx.meeting.findMany({
        where: {
          AND: [
            base,
            {
              startsAt: { gte: policy.asOf, lte: policy.upcomingThrough },
              status: { notIn: ['cancelled', 'canceled'] },
            },
          ],
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: 101,
        include: { notes: { take: 0 }, debriefs: { take: 0 } },
      }),
      tx.tenantMembership.findFirst({
        where: { tenantId, userId, status: 'active' },
        select: { role: true },
      }),
    ]);
    if (!membership)
      return {
        records: [],
        total: 0,
        hasMore: false,
        sourceStatus: 'unauthorized',
        degradedReason: 'meeting_actor_membership_unavailable',
      };
    const ctx = { tenantId, userId, role: membership.role } as TenantContext;
    let incomplete = past.length > policy.meetingLimit || upcoming.length > 100;
    const records = [...past.slice(0, policy.meetingLimit), ...upcoming.slice(0, 100)].map(
      (row) => {
        const gaps: string[] = [];
        function visible(entries: typeof row.notes | typeof row.debriefs) {
          if (entries.length > 50) gaps.push('artifact_limit_reached');
          return entries.slice(0, 50).flatMap((entry) => {
            if (!canReadEncryptedEntry(ctx, entry)) {
              gaps.push('restricted_artifact');
              return [];
            }
            try {
              if (!crypto) throw new Error('encryption_unavailable');
              const body = crypto.decrypt(entry);
              if (body.length > 60_000) gaps.push('artifact_excerpt_truncated');
              return [
                {
                  id: entry.id,
                  status: entry.status,
                  createdAt: entry.createdAt,
                  updatedAt: entry.updatedAt,
                  body: body.slice(0, 60_000),
                },
              ];
            } catch {
              gaps.push('artifact_decryption_unavailable');
              return [];
            }
          });
        }
        const notes = visible(row.notes);
        const debriefs = visible(row.debriefs);
        if (gaps.length) incomplete = true;
        return {
          domain: 'meetings' as const,
          recordId: row.id,
          occurredAt: row.startsAt,
          updatedAt: row.updatedAt,
          payload: object({
            id: row.id,
            clientId: row.clientId,
            subject: row.subject,
            description: row.description,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            status: row.status,
            organizerName: row.organizerName,
            organizerEmail: row.organizerEmail,
            notes,
            debriefs,
            contentCoverage: { gaps: [...new Set(gaps)], rawTranscript: 'not_searched' },
          }),
          provenance: { source: 'meetings_with_authorized_artifacts', recordId: row.id },
        };
      },
    );
    // Raw recordings are not silently represented as searched debrief bodies.
    return {
      records,
      total: past.length + upcoming.length,
      hasMore: false,
      degradedReason: incomplete
        ? 'meeting_history_or_artifact_scope_partial'
        : 'authorized_notes_debriefs_searched_raw_transcripts_not_searched',
    };
  }
  if (domain === 'mail') {
    const connections = await tx.integrationConnection.findMany({
      where: {
        tenantId,
        createdByUserId: userId,
        provider: { in: ['microsoft_365', 'google_workspace', 'imap_caldav'] },
        ...(request.caller.authorizedMailboxConnectionIds
          ? { id: { in: [...request.caller.authorizedMailboxConnectionIds] } }
          : {}),
      },
      select: { id: true, provider: true, status: true, lastSyncAt: true, syncState: true },
    });
    if (!connections.length)
      return {
        records: [],
        total: 0,
        hasMore: false,
        sourceStatus: 'unavailable',
        degradedReason: 'authorized_mailbox_connection_not_found',
      };
    // Old open promises pin their originating threads outside the recency window.
    const pinned = await tx.engagementTask.findMany({
      where: {
        tenantId,
        ...clientScope,
        status: { notIn: [...terminal] },
        mailThreadId: { not: null },
        ...(policy.scope === 'internal' ? { ownerUserId: userId } : {}),
      },
      select: { mailThreadId: true },
      take: 301,
    });
    const threads = await tx.mailThread.findMany({
      where: {
        AND: [
          {
            tenantId,
            ...clientScope,
            connectionId: { in: connections.map((row) => row.id) },
            ...lexical('subject'),
            OR: [
              { lastMessageAt: { gte: policy.emailSince, lte: policy.asOf } },
              { id: { in: pinned.flatMap((row) => (row.mailThreadId ? [row.mailThreadId] : [])) } },
            ],
          },
          ownMailThreadWhere(userId),
        ],
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'asc' }],
      take: policy.threadLimit + 1,
      select: { id: true },
    });
    const threadIds = [
      ...new Set([
        ...pinned.flatMap((row) => (row.mailThreadId ? [row.mailThreadId] : [])),
        ...threads.slice(0, policy.threadLimit).map((row) => row.id),
      ]),
    ];
    const messageSelect = {
      id: true,
      threadId: true,
      thread: { select: { clientId: true } },
      subject: true,
      fromEmail: true,
      fromName: true,
      toRecipients: true,
      ccRecipients: true,
      sentAt: true,
      receivedAt: true,
      updatedAt: true,
      bodyText: true,
    } as const;
    const messageWhere: Prisma.MailMessageWhereInput = {
      AND: [
        {
          tenantId,
          threadId: { in: threadIds },
          thread: { ...clientScope },
          connectionId: { in: connections.map((row) => row.id) },
        },
        ownMailMessageWhere(userId),
      ],
    };
    const threadWhere: Prisma.MailThreadWhereInput = {
      AND: [
        {
          tenantId,
          id: { in: threadIds },
          ...clientScope,
          connectionId: { in: connections.map((row) => row.id) },
        },
        ownMailThreadWhere(userId),
      ],
    };
    // Stratify across threads: preserve the original message AND latest response
    // before spending the remaining budget on important intermediate exchanges.
    // A single busy recent thread must not evict every old pinned commitment.
    const [originals, latest, totalMessages] = await Promise.all([
      tx.mailThread.findMany({
        where: threadWhere,
        select: {
          id: true,
          messages: {
            where: ownMailMessageWhere(userId),
            orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
            take: 1,
            select: messageSelect,
          },
        },
      }),
      tx.mailThread.findMany({
        where: threadWhere,
        select: {
          id: true,
          messages: {
            where: ownMailMessageWhere(userId),
            orderBy: [{ sentAt: 'desc' }, { id: 'asc' }],
            take: Math.max(1, Math.floor(policy.messageLimit / Math.max(1, threadIds.length)) - 2),
            select: messageSelect,
          },
        },
      }),
      tx.mailMessage.count({ where: messageWhere }),
    ]);
    const byThread = new Map(originals.map((row) => [row.id, row.messages]));
    const latestByThread = new Map(latest.map((row) => [row.id, row.messages]));
    const selected = new Map<string, (typeof originals)[number]['messages'][number]>();
    for (const id of threadIds)
      for (const message of [...(byThread.get(id) ?? []), ...(latestByThread.get(id) ?? [])]) {
        if (selected.size >= policy.messageLimit) break;
        selected.set(message.id, message);
      }
    if (selected.size < policy.messageLimit) {
      const intermediates = await tx.mailMessage.findMany({
        where: {
          AND: [
            messageWhere,
            {
              id: { notIn: [...selected.keys()] },
              OR: ['commit', 'will ', 'agree', 'resolv', 'decid', 'deadline', 'deliver'].map(
                (term) => ({ bodyText: { contains: term, mode: 'insensitive' as const } }),
              ),
            },
          ],
        },
        orderBy: [{ sentAt: 'desc' }, { id: 'asc' }],
        take: policy.messageLimit - selected.size,
        select: messageSelect,
      });
      for (const message of intermediates) selected.set(message.id, message);
    }
    if (selected.size < policy.messageLimit) {
      const remaining = await tx.mailMessage.findMany({
        where: { AND: [messageWhere, { id: { notIn: [...selected.keys()] } }] },
        orderBy: [{ sentAt: 'desc' }, { id: 'asc' }],
        take: policy.messageLimit - selected.size,
        select: messageSelect,
      });
      for (const message of remaining) selected.set(message.id, message);
    }
    const rows = [...selected.values()];
    const syncs = connections.map(getMailSyncCoverage);
    const partial =
      threads.length > policy.threadLimit ||
      totalMessages > rows.length ||
      pinned.length > 300 ||
      rows.some((row) => (row.bodyText?.length ?? 0) > 24_000) ||
      connections.some((row) => row.status !== 'connected') ||
      syncs.some((sync) => sync.sourceStatus !== 'healthy');
    return {
      records: rows.slice(0, policy.messageLimit).map((row) => ({
        domain: 'mail',
        recordId: row.id,
        occurredAt: row.sentAt ?? row.receivedAt,
        updatedAt: row.updatedAt,
        payload: object({
          ...row,
          clientId: row.thread?.clientId ?? null,
          bodyText: row.bodyText?.slice(0, 24_000),
          contentCoverage: { truncated: (row.bodyText?.length ?? 0) > 24_000 },
        }),
        provenance: { source: 'mail_messages', recordId: row.id },
      })),
      total: rows.length,
      hasMore: false,
      ...(partial ? { degradedReason: 'mail_history_cap_or_sync_gap' } : {}),
      lastSyncAt: syncs.every((sync) => sync.lastMailSyncAt)
        ? new Date(Math.min(...syncs.map((sync) => sync.lastMailSyncAt!.getTime())))
        : undefined,
    };
  }
  const rows = await tx.engagementTask.findMany({
    where: {
      tenantId,
      ...clientScope,
      ...(policy.scope === 'internal' ? { ownerUserId: userId, ...lexical('title') } : {}),
      OR: [{ status: { notIn: [...terminal] } }, { updatedAt: { gte: policy.emailSince } }],
    },
    orderBy: { id: 'asc' },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: 101,
    select: {
      id: true,
      clientId: true,
      title: true,
      description: true,
      status: true,
      dueDate: true,
      ownerUserId: true,
      meetingId: true,
      mailThreadId: true,
      updatedAt: true,
    },
  });
  return {
    records: rows.slice(0, 100).map((row) => ({
      domain: 'tasks',
      recordId: row.id,
      occurredAt: row.dueDate,
      updatedAt: row.updatedAt,
      payload: object(row),
      provenance: { source: 'engagement_tasks', recordId: row.id },
    })),
    total: rows.length,
    hasMore: rows.length > 100,
    ...(rows.length > 100 ? { nextCursor: rows[99]!.id } : {}),
  };
}
