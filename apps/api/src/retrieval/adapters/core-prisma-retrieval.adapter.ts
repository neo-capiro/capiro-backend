import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type {
  RetrievalDomain,
  RetrievalRecord,
  RetrievalRequest,
  RetrievalSourceResult,
  SemanticDatasetDescriptor,
} from '../retrieval-v2.types.js';

const MAX_PAGE_SIZE = 100;

type CoreDomain = 'clients' | 'contacts' | 'mail' | 'meetings' | 'tasks' | 'outreach';

interface PageResult {
  records: RetrievalRecord[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
  lastSyncAt?: Date;
  degradedReason?: string;
}

function jsonObject(value: unknown): KnowledgeJsonObject {
  return JSON.parse(JSON.stringify(value)) as KnowledgeJsonObject;
}

@Injectable()
export class CorePrismaRetrievalAdapter implements RetrievalSourceAdapter {
  readonly key = 'core-prisma';
  readonly domains = ['clients', 'contacts', 'mail', 'meetings', 'tasks', 'outreach'] as const;

  constructor(private readonly prisma: PrismaService) {}

  async retrieve(
    dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
    cursor?: string,
  ): Promise<RetrievalSourceResult> {
    if (!this.domains.includes(dataset.domain as CoreDomain)) {
      return this.unsupported(dataset.domain, 'domain_not_supported_by_core_prisma');
    }

    const requestedEntityCount = new Set(request.caller.clientIds ?? []).size;
    const temporalRequirementError = this.validateTemporalRequirements(
      dataset.domain as CoreDomain,
      request,
    );
    if (temporalRequirementError) {
      return this.unsupported(dataset.domain, temporalRequirementError, requestedEntityCount);
    }

    const pageSize = Math.min(Math.max(request.pageSize ?? 50, 1), MAX_PAGE_SIZE);

    return this.prisma.withTenant(request.caller.tenantId, async (tx) => {
      const visibleClientIds = await this.resolveVisibleClientIds(tx, request);
      if (
        this.hasExplicitClientScope(request) &&
        visibleClientIds.length !== requestedEntityCount
      ) {
        return {
          domain: dataset.domain,
          records: [],
          total: 0,
          returned: 0,
          hasMore: false,
          truncated: false,
          sourceStatus: 'unauthorized',
          recordsEvaluated: 0,
          requestedEntityCount,
          searchedEntityCount: visibleClientIds.length,
          pagesRead: 1,
          paginationComplete: false,
          coverageComplete: false,
          stopReason: 'requested_client_scope_not_fully_authorized',
        };
      }

      const page = await this.retrievePage(
        dataset.domain as CoreDomain,
        tx,
        request,
        visibleClientIds,
        pageSize,
        cursor,
      );
      const sourceStatus = page.degradedReason ? 'degraded' : 'healthy';
      const paginationComplete = !page.hasMore;
      const coverageComplete = sourceStatus === 'healthy' && paginationComplete;

      return {
        domain: dataset.domain,
        records: page.records,
        total: page.total,
        returned: page.records.length,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        truncated: page.hasMore,
        sourceStatus,
        lastSyncAt: page.lastSyncAt,
        recordsEvaluated: page.records.length + (page.hasMore ? 1 : 0),
        requestedEntityCount,
        searchedEntityCount: visibleClientIds.length,
        pagesRead: 1,
        paginationComplete,
        coverageComplete,
        stopReason:
          page.degradedReason ?? (page.hasMore ? 'page_boundary_reached' : 'authoritative_page_complete'),
      };
    });
  }

  private validateTemporalRequirements(domain: CoreDomain, request: RetrievalRequest): string | undefined {
    const needsWindow =
      (domain === 'clients' && request.queryClass === 'change_detection') ||
      (domain === 'mail' &&
        ['entity_history', 'relationship_history', 'change_detection'].includes(request.queryClass)) ||
      (domain === 'meetings' &&
        ['entity_history', 'relationship_history', 'change_detection'].includes(request.queryClass)) ||
      (domain === 'tasks' && request.queryClass === 'change_detection') ||
      (domain === 'outreach' &&
        ['entity_history', 'change_detection'].includes(request.queryClass));

    if (!needsWindow) return undefined;
    if (!request.windowStart || !request.windowEnd) return 'window_start_and_end_required';
    if (request.windowEnd <= request.windowStart) return 'invalid_time_window';
    return undefined;
  }

  private hasExplicitClientScope(request: RetrievalRequest): boolean {
    return (request.caller.clientIds?.length ?? 0) > 0;
  }

  private async resolveVisibleClientIds(
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
  ): Promise<string[]> {
    const requested = request.caller.clientIds ? [...new Set(request.caller.clientIds)] : undefined;
    const clients = await tx.client.findMany({
      where: {
        ...(requested && requested.length > 0 ? { id: { in: requested } } : {}),
        OR: [
          { memoryWall: false },
          { memoryAccessGrants: { some: { userId: request.caller.userId } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return clients.map((client) => client.id);
  }

  private retrievePage(
    domain: CoreDomain,
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
    visibleClientIds: string[],
    pageSize: number,
    cursor?: string,
  ): Promise<PageResult> {
    switch (domain) {
      case 'clients':
        return this.retrieveClients(tx, request, visibleClientIds, pageSize, cursor);
      case 'contacts':
        return this.retrieveContacts(tx, request, visibleClientIds, pageSize, cursor);
      case 'mail':
        return this.retrieveMail(tx, request, visibleClientIds, pageSize, cursor);
      case 'meetings':
        return this.retrieveMeetings(tx, request, visibleClientIds, pageSize, cursor);
      case 'tasks':
        return this.retrieveTasks(tx, request, visibleClientIds, pageSize, cursor);
      case 'outreach':
        return this.retrieveOutreach(tx, request, visibleClientIds, pageSize, cursor);
    }
  }

  private async retrieveClients(
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
    visibleClientIds: string[],
    pageSize: number,
    cursor?: string,
  ): Promise<PageResult> {
    const query = request.query?.trim();
    const where: Prisma.ClientWhereInput = {
      id: { in: visibleClientIds },
      ...(request.queryClass === 'change_detection'
        ? { updatedAt: { gte: request.windowStart!, lt: request.windowEnd! } }
        : {}),
      ...(query
        ? {
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
              { website: { contains: query, mode: 'insensitive' } },
              { primaryContactName: { contains: query, mode: 'insensitive' } },
              { primaryContactEmail: { contains: query, mode: 'insensitive' } },
              { sectorTag: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      tx.client.count({ where }),
      tx.client.findMany({
        where,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: pageSize + 1,
        select: {
          id: true,
          name: true,
          description: true,
          website: true,
          status: true,
          sectorTag: true,
          profileType: true,
          profileStatus: true,
          primaryContactName: true,
          primaryContactEmail: true,
          uei: true,
          cageCode: true,
          naicsCodes: true,
          pscCodes: true,
          issueCodes: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);
    return this.page('clients', rows, total, pageSize, (row) => ({
      domain: 'clients',
      recordId: row.id,
      entityRef: { type: 'client', id: row.id },
      updatedAt: row.updatedAt,
      payload: jsonObject(row),
      provenance: { source: 'clients', recordId: row.id },
    }));
  }

  private async retrieveContacts(
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
    visibleClientIds: string[],
    pageSize: number,
    cursor?: string,
  ): Promise<PageResult> {
    const query = request.query?.trim();
    const clientScope: Prisma.EngagementContactWhereInput = this.hasExplicitClientScope(request)
      ? { clientId: { in: visibleClientIds } }
      : { OR: [{ clientId: null }, { clientId: { in: visibleClientIds } }] };
    const where: Prisma.EngagementContactWhereInput = {
      AND: [
        clientScope,
        ...(query
          ? [
              {
                OR: [
                  { fullName: { contains: query, mode: 'insensitive' as const } },
                  { email: { contains: query, mode: 'insensitive' as const } },
                  { organization: { contains: query, mode: 'insensitive' as const } },
                  { title: { contains: query, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };
    const [total, rows] = await Promise.all([
      tx.engagementContact.count({ where }),
      tx.engagementContact.findMany({
        where,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: pageSize + 1,
        select: {
          id: true,
          clientId: true,
          directoryEntryId: true,
          acquisitionPersonnelId: true,
          fullName: true,
          email: true,
          phone: true,
          organization: true,
          title: true,
          source: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);
    return this.page('contacts', rows, total, pageSize, (row) => ({
      domain: 'contacts',
      recordId: row.id,
      entityRef: { type: 'contact', id: row.id },
      updatedAt: row.updatedAt,
      payload: jsonObject(row),
      provenance: { source: 'engagement_contacts', recordId: row.id },
    }));
  }

  private async retrieveMail(
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
    visibleClientIds: string[],
    pageSize: number,
    cursor?: string,
  ): Promise<PageResult> {
    const query = request.query?.trim();
    const threadScope: Prisma.MailMessageWhereInput = this.hasExplicitClientScope(request)
      ? { thread: { clientId: { in: visibleClientIds } } }
      : { thread: { OR: [{ clientId: null }, { clientId: { in: visibleClientIds } }] } };
    const temporalScope: Prisma.MailMessageWhereInput | undefined =
      request.queryClass === 'change_detection'
        ? { updatedAt: { gte: request.windowStart!, lt: request.windowEnd! } }
        : request.queryClass === 'entity_history' || request.queryClass === 'relationship_history'
          ? {
              OR: [
                { receivedAt: { gte: request.windowStart!, lt: request.windowEnd! } },
                { sentAt: { gte: request.windowStart!, lt: request.windowEnd! } },
              ],
            }
          : undefined;
    const where: Prisma.MailMessageWhereInput = {
      removedAt: null,
      AND: [
        threadScope,
        ...(temporalScope ? [temporalScope] : []),
        ...(query
          ? [
              {
                OR: [
                  { subject: { contains: query, mode: 'insensitive' as const } },
                  { fromEmail: { contains: query, mode: 'insensitive' as const } },
                  { fromName: { contains: query, mode: 'insensitive' as const } },
                  { bodyText: { contains: query, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };
    const [total, rows, sync] = await Promise.all([
      tx.mailMessage.count({ where }),
      tx.mailMessage.findMany({
        where,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: pageSize + 1,
        select: {
          id: true,
          threadId: true,
          source: true,
          subject: true,
          fromEmail: true,
          fromName: true,
          toRecipients: true,
          ccRecipients: true,
          sentAt: true,
          receivedAt: true,
          bodyText: true,
          hasAttachments: true,
          createdAt: true,
          updatedAt: true,
          thread: { select: { clientId: true, subject: true } },
        },
      }),
      tx.integrationConnection.findFirst({
        where: { status: 'connected' },
        orderBy: { lastSyncAt: 'desc' },
        select: { lastSyncAt: true },
      }),
    ]);
    const result = this.page('mail', rows, total, pageSize, (row) => ({
      domain: 'mail',
      recordId: row.id,
      entityRef: { type: 'mail_message', id: row.id },
      occurredAt: row.receivedAt ?? row.sentAt,
      updatedAt: row.updatedAt,
      payload: jsonObject({
        ...row,
        bodyText: row.bodyText?.slice(0, 4000) ?? null,
      }),
      provenance: { source: 'mail_messages', recordId: row.id },
    }));
    result.lastSyncAt = sync?.lastSyncAt ?? undefined;
    return result;
  }

  private async retrieveMeetings(
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
    visibleClientIds: string[],
    pageSize: number,
    cursor?: string,
  ): Promise<PageResult> {
    const query = request.query?.trim();
    const clientScope: Prisma.MeetingWhereInput = this.hasExplicitClientScope(request)
      ? { clientId: { in: visibleClientIds } }
      : { OR: [{ clientId: null }, { clientId: { in: visibleClientIds } }] };
    const temporalScope: Prisma.MeetingWhereInput | undefined =
      request.queryClass === 'change_detection'
        ? { updatedAt: { gte: request.windowStart!, lt: request.windowEnd! } }
        : request.queryClass === 'entity_history' || request.queryClass === 'relationship_history'
          ? {
              AND: [
                { startsAt: { lt: request.windowEnd! } },
                { endsAt: { gt: request.windowStart! } },
              ],
            }
          : undefined;
    const where: Prisma.MeetingWhereInput = {
      AND: [
        clientScope,
        { OR: [{ createdByUserId: request.caller.userId }, { sharedAt: { not: null } }] },
        ...(temporalScope ? [temporalScope] : []),
        ...(query
          ? [
              {
                OR: [
                  { subject: { contains: query, mode: 'insensitive' as const } },
                  { description: { contains: query, mode: 'insensitive' as const } },
                  { organizerName: { contains: query, mode: 'insensitive' as const } },
                  { organizerEmail: { contains: query, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };
    const [total, rows, sync] = await Promise.all([
      tx.meeting.count({ where }),
      tx.meeting.findMany({
        where,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: pageSize + 1,
        select: {
          id: true,
          clientId: true,
          source: true,
          subject: true,
          description: true,
          location: true,
          startsAt: true,
          endsAt: true,
          organizerEmail: true,
          organizerName: true,
          status: true,
          visibility: true,
          sharedAt: true,
          createdByUserId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      tx.integrationConnection.findFirst({
        where: { status: 'connected' },
        orderBy: { lastSyncAt: 'desc' },
        select: { lastSyncAt: true },
      }),
    ]);
    const result = this.page('meetings', rows, total, pageSize, (row) => ({
      domain: 'meetings',
      recordId: row.id,
      entityRef: { type: 'meeting', id: row.id },
      occurredAt: row.startsAt,
      updatedAt: row.updatedAt,
      payload: jsonObject(row),
      provenance: { source: 'meetings', recordId: row.id },
    }));
    result.lastSyncAt = sync?.lastSyncAt ?? undefined;
    result.degradedReason = 'meeting_metadata_complete_but_authorized_debrief_body_adapter_not_wired';
    return result;
  }

  private async retrieveTasks(
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
    visibleClientIds: string[],
    pageSize: number,
    cursor?: string,
  ): Promise<PageResult> {
    const query = request.query?.trim();
    const clientScope: Prisma.EngagementTaskWhereInput = this.hasExplicitClientScope(request)
      ? { clientId: { in: visibleClientIds } }
      : { OR: [{ clientId: null }, { clientId: { in: visibleClientIds } }] };
    const where: Prisma.EngagementTaskWhereInput = {
      AND: [
        clientScope,
        ...(request.queryClass === 'change_detection'
          ? [{ updatedAt: { gte: request.windowStart!, lt: request.windowEnd! } }]
          : []),
        ...(query
          ? [
              {
                OR: [
                  { title: { contains: query, mode: 'insensitive' as const } },
                  { description: { contains: query, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };
    const [total, rows] = await Promise.all([
      tx.engagementTask.count({ where }),
      tx.engagementTask.findMany({
        where,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: pageSize + 1,
        select: {
          id: true,
          clientId: true,
          meetingId: true,
          contactId: true,
          mailThreadId: true,
          title: true,
          description: true,
          ownerUserId: true,
          dueDate: true,
          status: true,
          sourceType: true,
          sourceId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);
    return this.page('tasks', rows, total, pageSize, (row) => ({
      domain: 'tasks',
      recordId: row.id,
      entityRef: { type: 'task', id: row.id },
      occurredAt: row.dueDate,
      updatedAt: row.updatedAt,
      payload: jsonObject(row),
      provenance: { source: 'engagement_tasks', recordId: row.id },
    }));
  }

  private async retrieveOutreach(
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
    visibleClientIds: string[],
    pageSize: number,
    cursor?: string,
  ): Promise<PageResult> {
    const query = request.query?.trim();
    const clientScope: Prisma.OutreachRecordWhereInput = this.hasExplicitClientScope(request)
      ? { clientId: { in: visibleClientIds } }
      : { OR: [{ clientId: null }, { clientId: { in: visibleClientIds } }] };
    const temporalScope: Prisma.OutreachRecordWhereInput | undefined =
      request.queryClass === 'change_detection'
        ? { updatedAt: { gte: request.windowStart!, lt: request.windowEnd! } }
        : request.queryClass === 'entity_history'
          ? {
              OR: [
                { createdAt: { gte: request.windowStart!, lt: request.windowEnd! } },
                { sentAt: { gte: request.windowStart!, lt: request.windowEnd! } },
              ],
            }
          : undefined;
    const where: Prisma.OutreachRecordWhereInput = {
      deletedAt: null,
      AND: [
        clientScope,
        ...(temporalScope ? [temporalScope] : []),
        ...(query
          ? [
              {
                OR: [
                  { title: { contains: query, mode: 'insensitive' as const } },
                  { subject: { contains: query, mode: 'insensitive' as const } },
                  { body: { contains: query, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };
    const [total, rows] = await Promise.all([
      tx.outreachRecord.count({ where }),
      tx.outreachRecord.findMany({
        where,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: pageSize + 1,
        select: {
          id: true,
          clientId: true,
          meetingId: true,
          type: true,
          status: true,
          title: true,
          subject: true,
          body: true,
          recipients: true,
          recipientCount: true,
          stats: true,
          sentAt: true,
          createdByUserId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);
    return this.page('outreach', rows, total, pageSize, (row) => ({
      domain: 'outreach',
      recordId: row.id,
      entityRef: { type: 'outreach', id: row.id },
      occurredAt: row.sentAt ?? row.createdAt,
      updatedAt: row.updatedAt,
      payload: jsonObject(row),
      provenance: { source: 'outreach_records', recordId: row.id },
    }));
  }

  private page<T extends { id: string; updatedAt?: Date }>(
    domain: RetrievalDomain,
    rows: T[],
    total: number,
    pageSize: number,
    mapRecord: (row: T) => RetrievalRecord,
  ): PageResult {
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const records = pageRows.map(mapRecord);
    const newest = pageRows.reduce<Date | undefined>((latest, row) => {
      if (!row.updatedAt) return latest;
      return !latest || row.updatedAt > latest ? row.updatedAt : latest;
    }, undefined);
    return {
      records,
      total,
      hasMore,
      nextCursor: hasMore ? pageRows.at(-1)?.id : undefined,
      lastSyncAt: newest,
    };
  }

  private unsupported(
    domain: RetrievalDomain,
    stopReason: string,
    requestedEntityCount = 0,
  ): RetrievalSourceResult {
    return {
      domain,
      records: [],
      returned: 0,
      hasMore: false,
      truncated: false,
      sourceStatus: 'unsupported',
      recordsEvaluated: 0,
      requestedEntityCount,
      searchedEntityCount: 0,
      pagesRead: 0,
      paginationComplete: false,
      coverageComplete: false,
      stopReason,
    };
  }
}
