import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  type ClientFundingOpportunity,
  type TangoDibbsSolicitation,
  type TangoProcurementForecast,
  type TangoSbirTopic,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  readVisibleClientIds,
  dibbsInboxTitle,
  sbirInboxTitle,
  toInboxForecastFacts,
  toInboxDibbsFacts,
  toInboxSbirFacts,
  type InboxForecastFacts,
  type InboxDibbsFacts,
  type InboxSbirFacts,
} from './funding-opportunity-inbox.service.js';
import {
  assertRequestSourceRecordId,
  sourceRecordIdentityColumns,
  sourceRecordWhere,
} from './funding-opportunity-identity.js';
import { requireFundingSourceAccess } from './funding-opportunity-source-access.js';
import type { HumanDecision, OpportunityDecision } from './funding-opportunities.types.js';
import { fundingFollowupPatch } from './funding-opportunity-followup.js';
import { readFundingWorkflowForUpdate } from './funding-opportunity-workflow-lock.js';
import { syncExistingFundingActionTask } from './funding-opportunity-task-link.js';
import { isTopicClosed } from './sbir-relevance.js';

export const TANGO_OPPORTUNITY_FEEDS = ['agency_forecast', 'dibbs', 'sbir_sttr'] as const;
export type TangoOpportunityFeed = (typeof TANGO_OPPORTUNITY_FEEDS)[number];
export function isTangoOpportunityFeed(source: string): source is TangoOpportunityFeed {
  return (TANGO_OPPORTUNITY_FEEDS as readonly string[]).includes(source);
}
export interface FundingFeedQuery {
  clientId?: string;
  q?: string;
  agency?: string;
  naics?: string;
  activeState?: 'active' | 'closed' | 'all';
  page?: number;
  pageSize?: number;
}
export interface FundingFeedRecord {
  source: TangoOpportunityFeed;
  sourceRecordId: string;
  title: string;
  description: string | null;
  agency: string | null;
  sourceUrl: string | null;
  responseDeadline: string | null;
  anticipatedAwardDate: string | null;
  status: string | null;
  isActive: boolean | null;
  naicsCode: string | null;
  lastSyncedAt: string;
  sourceUpdatedAt: string | null;
  facts: InboxForecastFacts | InboxDibbsFacts | InboxSbirFacts;
  workflow: {
    id: string;
    status: string;
    notes: string | null;
    ownerUserId: string | null;
    nextAction: string | null;
    nextActionDueAt: string | null;
  } | null;
  decision: OpportunityDecision | null;
  clientId: string | null;
}
export interface FundingFeedFreshness {
  state: 'not_synced' | 'current' | 'stale' | 'failed' | 'unknown';
  lastObservedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastRunStatus: string | null;
}
type FeedRow =
  | { source: 'agency_forecast'; row: TangoProcurementForecast }
  | { source: 'dibbs'; row: TangoDibbsSolicitation }
  | { source: 'sbir_sttr'; row: TangoSbirTopic };
type WorkflowInput = {
  status?: 'saved' | 'pursuing' | 'won' | 'lost' | 'dismissed';
  decision?: HumanDecision;
  ownerUserId?: string | null;
  facilityId?: string | null;
  notes?: string | null;
  reason?: string | null;
  outcomeNote?: string | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  restore?: boolean;
};
const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

/** Global source reads are bounded and separate from short tenant workflow transactions. */
@Injectable()
export class FundingOpportunityFeedService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    actorUserId: string,
    source: TangoOpportunityFeed,
    query: FundingFeedQuery,
  ) {
    await requireFundingSourceAccess(this.prisma, tenantId, source);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      throw new BadRequestException('Use a positive page and a pageSize from 1 to 100.');
    }
    if (query.naics && source !== 'agency_forecast')
      throw new BadRequestException('This feed does not publish NAICS codes.');
    const clientId = query.clientId
      ? await this.visibleClient(tenantId, actorUserId, query.clientId)
      : null;
    const { records, total } = await this.catalogPage(source, query, page, pageSize);
    const shaped = await this.shape(records);
    if (clientId) {
      const workflows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.clientFundingOpportunity.findMany({
          where: {
            tenantId,
            clientId,
            source,
            sourceRecordKey: { in: shaped.map((r) => r.sourceRecordId) },
          },
        }),
      );
      const byKey = new Map(workflows.map((w) => [w.sourceRecordKey, w]));
      for (const record of shaped)
        this.attachWorkflow(record, clientId, byKey.get(record.sourceRecordId));
    }
    return {
      source,
      clientId,
      rows: shaped,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      freshness: await this.freshness(source),
      generatedAt: new Date().toISOString(),
    };
  }

  async detail(
    tenantId: string,
    actorUserId: string,
    source: TangoOpportunityFeed,
    id: string,
    clientId?: string | null,
  ): Promise<FundingFeedRecord> {
    await requireFundingSourceAccess(this.prisma, tenantId, source);
    const appliedClientId = clientId
      ? await this.visibleClient(tenantId, actorUserId, clientId)
      : null;
    const raw = await this.readOne(source, id);
    const record = (await this.shape([raw]))[0]!;
    if (appliedClientId) {
      const workflow = await this.prisma.withTenant(tenantId, (tx) =>
        tx.clientFundingOpportunity.findFirst({
          where: {
            tenantId,
            clientId: appliedClientId,
            ...sourceRecordWhere(source, id),
          },
        }),
      );
      this.attachWorkflow(record, appliedClientId, workflow ?? undefined);
    }
    return record;
  }

  /** Used by the atomic Engagement action service; source dates stay source dates. */
  async describeForAction(source: TangoOpportunityFeed, id: string) {
    const record = (await this.shape([await this.readOne(source, id)]))[0]!;
    const pursuitRefusal =
      source === 'agency_forecast'
        ? 'An agency forecast is an early plan. Watch it or create a review task until a solicitation exists.'
        : record.isActive === false
          ? 'This opportunity is closed and cannot be pursued.'
          : record.isActive == null
            ? 'The source has not confirmed this opportunity is open. Save it or create a review task first.'
            : null;
    return {
      title: record.title,
      sourceReference: record.sourceRecordId,
      sourceUrl: record.sourceUrl,
      responseDeadline: record.responseDeadline,
      isPursuable: pursuitRefusal === null,
      pursuitRefusal,
    };
  }

  async write(
    tenantId: string,
    actorUserId: string,
    clientId: string,
    source: TangoOpportunityFeed,
    id: string,
    input: WorkflowInput,
  ) {
    await requireFundingSourceAccess(this.prisma, tenantId, source);
    await this.visibleClient(tenantId, actorUserId, clientId);
    const record = (await this.shape([await this.readOne(source, id)]))[0]!;
    const isPursuit = input.status === 'pursuing' || input.decision === 'pursue';
    if (
      source === 'agency_forecast' &&
      (isPursuit || input.status === 'won' || input.status === 'lost')
    ) {
      throw new BadRequestException(
        'Forecasts can be saved or watched; pursue the published solicitation when it exists.',
      );
    }
    if (isPursuit && record.isActive !== true)
      throw new BadRequestException(
        record.isActive === false
          ? 'A closed opportunity cannot be pursued.'
          : 'The source has not confirmed this opportunity is open. Save it or create a review task first.',
      );
    const write = () =>
      this.prisma.withTenant(tenantId, async (tx) => {
        // Keep wall/assignment checks inside the write transaction as well.
        if (!(await readVisibleClientIds(tx, tenantId, actorUserId)).includes(clientId))
          throw new NotFoundException('Client not found.');
        if (
          input.ownerUserId &&
          !(await tx.user.findFirst({
            where: { id: input.ownerUserId },
            select: { id: true },
          }))
        )
          throw new BadRequestException('Owner must belong to this team.');
        if (
          input.facilityId &&
          !(await tx.clientFacility.findFirst({
            where: { id: input.facilityId, clientId },
            select: { id: true },
          }))
        )
          throw new BadRequestException('Facility must belong to this client.');
        const existing = await readFundingWorkflowForUpdate(tx, clientId, source, id);
        if (
          input.restore &&
          (!existing ||
            (existing.workflowStatus !== 'dismissed' && existing.humanDecision !== 'pass'))
        )
          throw new BadRequestException('Only passed or dismissed opportunities can be restored.');
        const followup = fundingFollowupPatch(input, existing);
        const protectedWorkflow =
          existing &&
          (['pursue', 'pass'].includes(existing.humanDecision ?? '') ||
            ['pursuing', 'won', 'lost', 'dismissed', 'expired'].includes(existing.workflowStatus));
        if (
          isPursuit &&
          existing &&
          (existing.humanDecision === 'pass' ||
            ['won', 'lost', 'dismissed', 'expired'].includes(existing.workflowStatus))
        )
          throw new BadRequestException('Restore or reopen this record before pursuing it.');
        if (input.decision === 'monitor' && protectedWorkflow)
          throw new BadRequestException(
            'Use the existing pursuit or restore the closed record before changing it to Watch.',
          );
        const status =
          input.status === 'saved' && protectedWorkflow && !input.restore
            ? existing.workflowStatus
            : input.restore
              ? 'saved'
              : input.decision === 'pursue'
                ? 'pursuing'
                : input.decision === 'monitor'
                  ? 'saved'
                  : (input.status ?? existing?.workflowStatus ?? 'saved');
        const data = {
          workflowStatus: status,
          userCreated: true,
          staleAt: null,
          updatedBy: actorUserId,
          sourceStatusSnapshot: record.status,
          sourceActiveSnapshot: record.isActive,
          responseDeadlineSnapshot: record.responseDeadline
            ? new Date(record.responseDeadline)
            : null,
          sourceUpdatedAtSnapshot: record.sourceUpdatedAt ? new Date(record.sourceUpdatedAt) : null,
          ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
          ...(input.facilityId !== undefined ? { facilityId: input.facilityId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
          ...(input.outcomeNote !== undefined
            ? { outcomeNote: input.outcomeNote?.trim() || null }
            : {}),
          ...followup,
          ...(input.decision
            ? {
                humanDecision: input.decision,
                decisionReason: input.reason?.trim() || null,
                decisionAt: new Date(),
                decisionByUserId: actorUserId,
              }
            : {}),
          ...(input.status === 'dismissed'
            ? { dismissedReason: input.reason?.trim() || null }
            : {}),
          ...(input.restore
            ? {
                humanDecision: null,
                decisionReason: null,
                decisionAt: null,
                decisionByUserId: null,
                dismissedReason: null,
              }
            : {}),
        };
        const saved = existing
          ? await tx.clientFundingOpportunity.update({
              where: { id: existing.id },
              data,
            })
          : await tx.clientFundingOpportunity.create({
              data: {
                tenantId,
                clientId,
                source,
                ...sourceRecordIdentityColumns(source, id),
                evidenceSourceType: 'user_action',
                createdBy: actorUserId,
                ...data,
              },
            });
        if (saved.humanDecision === 'pursue' || saved.humanDecision === 'monitor')
          await syncExistingFundingActionTask(tx, {
            tenantId,
            clientId,
            source,
            sourceRecordId: id,
            intent: saved.humanDecision === 'pursue' ? 'pursuit' : 'review',
            ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
            ...followup,
          });
        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId,
            action: `funding_opportunity.${input.restore ? 'restored' : (input.decision ?? status)}`,
            entityType: 'client_funding_opportunity',
            entityId: saved.id,
            before: existing
              ? {
                  workflowStatus: existing.workflowStatus,
                  humanDecision: existing.humanDecision,
                }
              : undefined,
            after: {
              workflowStatus: saved.workflowStatus,
              humanDecision: saved.humanDecision,
            },
          },
        });
        return saved;
      });
    let saved: ClientFundingOpportunity;
    try {
      saved = await write();
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error;
      saved = await write();
    }
    this.attachWorkflow(record, clientId, saved);
    return input.decision
      ? record.decision
      : {
          id: saved.id,
          status: saved.workflowStatus,
          clientId,
          ownerUserId: saved.ownerUserId,
          nextAction: saved.nextAction ?? null,
          nextActionDueAt: iso(saved.nextActionDueAt),
          notes: saved.notes,
          decision: record.decision,
        };
  }

  private async visibleClient(
    tenantId: string,
    actorUserId: string,
    clientId: string,
  ): Promise<string> {
    const visible = await this.prisma.withTenant(tenantId, (tx) =>
      readVisibleClientIds(tx, tenantId, actorUserId),
    );
    if (!visible.includes(clientId)) throw new NotFoundException('Client not found.');
    return clientId;
  }

  private async readOne(source: TangoOpportunityFeed, id: string): Promise<FeedRow> {
    assertRequestSourceRecordId(source, id);
    // tenant-scope-exempt: public provider reference tables have no tenant_id.
    if (source === 'agency_forecast') {
      const row = await this.prisma.tangoProcurementForecast.findUnique({
        where: { tangoForecastId: id },
      });
      if (row) return { source, row };
    } else if (source === 'dibbs') {
      const row = await this.prisma.tangoDibbsSolicitation.findUnique({
        where: { tangoDibbsId: id },
      });
      if (row) return { source, row };
    } else {
      const row = await this.prisma.tangoSbirTopic.findUnique({
        where: { tangoSbirId: id },
      });
      if (row) return { source, row };
    }
    throw new NotFoundException('Opportunity not found.');
  }

  private async catalogPage(
    source: TangoOpportunityFeed,
    query: FundingFeedQuery,
    page: number,
    pageSize: number,
  ): Promise<{ records: FeedRow[]; total: number }> {
    const state = query.activeState ?? 'active';
    const q = query.q?.trim();
    const agency = query.agency?.trim();
    const contains = (value: string) => ({
      contains: value,
      mode: 'insensitive' as const,
    });
    const paging = { skip: (page - 1) * pageSize, take: pageSize };
    // tenant-scope-exempt: public provider reference tables have no tenant_id.
    if (source === 'agency_forecast') {
      const where: Prisma.TangoProcurementForecastWhereInput = {
        AND: [
          ...(state === 'all'
            ? []
            : [
                state === 'closed'
                  ? { isActive: false }
                  : { OR: [{ isActive: true }, { isActive: null }] },
              ]),
          ...(q
            ? [
                {
                  OR: [
                    { title: contains(q) },
                    { description: contains(q) },
                    { externalId: contains(q) },
                  ],
                },
              ]
            : []),
          ...(agency ? [{ agency: contains(agency) }] : []),
          ...(query.naics ? [{ naicsCode: query.naics }] : []),
        ],
      };
      const [rows, total] = await Promise.all([
        this.prisma.tangoProcurementForecast.findMany({
          where,
          ...paging,
          orderBy: [
            { providerModifiedAt: { sort: 'desc', nulls: 'last' } },
            { tangoForecastId: 'asc' },
          ],
        }),
        this.prisma.tangoProcurementForecast.count({ where }),
      ]);
      return { records: rows.map((row) => ({ source, row })), total };
    }
    if (source === 'dibbs') {
      const where: Prisma.TangoDibbsSolicitationWhereInput = {
        AND: [
          ...(state === 'all'
            ? []
            : [
                state === 'closed'
                  ? {
                      OR: [
                        { isOpen: false },
                        {
                          closesDate: {
                            lt: new Date(new Date().toISOString().slice(0, 10)),
                          },
                        },
                      ],
                    }
                  : {
                      AND: [
                        { OR: [{ isOpen: true }, { isOpen: null }] },
                        {
                          OR: [
                            { closesDate: null },
                            {
                              closesDate: {
                                gte: new Date(new Date().toISOString().slice(0, 10)),
                              },
                            },
                          ],
                        },
                      ],
                    },
              ]),
          ...(q
            ? [
                {
                  OR: [
                    { solicitation: contains(q) },
                    { nomenclature: contains(q) },
                    { partNumber: contains(q) },
                    { nsn: contains(q) },
                  ],
                },
              ]
            : []),
          ...(agency && !'defense logistics agency dla'.includes(agency.toLowerCase())
            ? [{ id: { in: [] } }]
            : []),
        ],
      };
      const [rows, total] = await Promise.all([
        this.prisma.tangoDibbsSolicitation.findMany({
          where,
          ...paging,
          orderBy: [{ closesDate: { sort: 'asc', nulls: 'last' } }, { tangoDibbsId: 'asc' }],
        }),
        this.prisma.tangoDibbsSolicitation.count({ where }),
      ]);
      return { records: rows.map((row) => ({ source, row })), total };
    }
    const today = new Date(new Date().toISOString().slice(0, 10));
    const closed: Prisma.TangoSbirTopicWhereInput = {
      OR: [
        { closeDate: { lt: today } },
        ...['closed', 'archived', 'expired'].map((value) => ({
          solicitationStatus: { equals: value, mode: 'insensitive' as const },
        })),
      ],
    };
    // Explicit nullable branches: Prisma NOT on nullable columns also removes NULLs.
    const open: Prisma.TangoSbirTopicWhereInput = {
      AND: [
        { OR: [{ closeDate: null }, { closeDate: { gte: today } }] },
        {
          OR: [
            { solicitationStatus: null },
            {
              NOT: ['closed', 'archived', 'expired'].map((value) => ({
                solicitationStatus: {
                  equals: value,
                  mode: 'insensitive' as const,
                },
              })),
            },
          ],
        },
      ],
    };
    const where: Prisma.TangoSbirTopicWhereInput = {
      AND: [
        ...(state === 'all' ? [] : [state === 'closed' ? closed : open]),
        ...(q
          ? [
              {
                OR: [
                  { title: contains(q) },
                  { topicNumber: contains(q) },
                  { solicitationNumber: contains(q) },
                ],
              },
            ]
          : []),
        ...(agency ? [{ agency: contains(agency) }] : []),
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.tangoSbirTopic.findMany({
        where,
        ...paging,
        orderBy: [{ closeDate: { sort: 'asc', nulls: 'last' } }, { tangoSbirId: 'asc' }],
      }),
      this.prisma.tangoSbirTopic.count({ where }),
    ]);
    return { records: rows.map((row) => ({ source, row })), total };
  }

  private async shape(records: FeedRow[]): Promise<FundingFeedRecord[]> {
    const cycleNumbers = [
      ...new Set(
        records.flatMap((r) =>
          r.source === 'sbir_sttr' && r.row.solicitationNumber ? [r.row.solicitationNumber] : [],
        ),
      ),
    ];
    const cycles = cycleNumbers.length
      ? await this.prisma.tangoSbirSolicitation.findMany({
          where: { solicitationNumber: { in: cycleNumbers } },
        })
      : [];
    const cycleByNumber = new Map(cycles.map((c) => [c.solicitationNumber, c]));
    return records.map((item): FundingFeedRecord => {
      const common = {
        source: item.source,
        lastSyncedAt: item.row.lastSyncedAt.toISOString(),
        workflow: null,
        decision: null,
        clientId: null,
      };
      if (item.source === 'agency_forecast') {
        const r = item.row;
        return {
          ...common,
          sourceRecordId: r.tangoForecastId,
          title: r.title,
          description: r.description,
          agency: r.agency,
          sourceUrl: r.sourceUrl,
          responseDeadline: null,
          anticipatedAwardDate: iso(r.anticipatedAwardDate)?.slice(0, 10) ?? null,
          status: r.status,
          isActive: r.isActive,
          naicsCode: r.naicsCode,
          sourceUpdatedAt: iso(r.providerModifiedAt),
          facts: toInboxForecastFacts(r),
        };
      }
      if (item.source === 'dibbs') {
        const r = item.row;
        return {
          ...common,
          sourceRecordId: r.tangoDibbsId,
          title: dibbsInboxTitle(r),
          description: r.nomenclature,
          agency: 'Defense Logistics Agency',
          sourceUrl: r.documentUrl,
          responseDeadline: iso(r.closesDate),
          anticipatedAwardDate: null,
          status: r.statusCode,
          isActive:
            r.closesDate && r.closesDate < new Date(new Date().toISOString().slice(0, 10))
              ? false
              : r.isOpen,
          naicsCode: null,
          sourceUpdatedAt: null,
          facts: toInboxDibbsFacts(r),
        };
      }
      const r = item.row;
      return {
        ...common,
        sourceRecordId: r.tangoSbirId,
        title: sbirInboxTitle(r),
        description: null,
        agency: r.agency,
        sourceUrl: r.topicUrl ?? r.officialSolicitationUrl,
        responseDeadline: iso(r.closeDate),
        anticipatedAwardDate: null,
        status: r.solicitationStatus,
        isActive: isTopicClosed({
          solicitationStatus: r.solicitationStatus,
          closeDate: iso(r.closeDate),
          asOf: new Date(),
        })
          ? false
          : r.solicitationStatus == null && r.closeDate == null
            ? null
            : true,
        naicsCode: null,
        sourceUpdatedAt: null,
        facts: toInboxSbirFacts(
          r,
          r.solicitationNumber ? (cycleByNumber.get(r.solicitationNumber) ?? null) : null,
        ),
      };
    });
  }

  private attachWorkflow(
    record: FundingFeedRecord,
    clientId: string,
    row?: ClientFundingOpportunity,
  ) {
    record.clientId = clientId;
    if (!row) return;
    record.workflow = {
      id: row.id,
      status: row.workflowStatus,
      notes: row.notes,
      ownerUserId: row.ownerUserId,
      nextAction: row.nextAction ?? null,
      nextActionDueAt: iso(row.nextActionDueAt),
    };
    record.decision =
      row.humanDecision && row.decisionAt && row.decisionByUserId
        ? {
            decision: row.humanDecision as HumanDecision,
            reason: row.decisionReason,
            decidedAt: row.decisionAt.toISOString(),
            decidedByUserId: row.decisionByUserId,
            nextAction: row.nextAction,
            nextActionDueAt: iso(row.nextActionDueAt),
          }
        : null;
  }

  private async freshness(source: TangoOpportunityFeed): Promise<FundingFeedFreshness> {
    const verb =
      source === 'agency_forecast'
        ? 'sync-tango-forecasts'
        : source === 'dibbs'
          ? 'sync-tango-dibbs'
          : 'sync-tango-sbir';
    try {
      const aggregate =
        source === 'agency_forecast'
          ? await this.prisma.tangoProcurementForecast.aggregate({
              _max: { lastSyncedAt: true },
            })
          : source === 'dibbs'
            ? await this.prisma.tangoDibbsSolicitation.aggregate({
                _max: { lastSyncedAt: true },
              })
            : await this.prisma.tangoSbirTopic.aggregate({
                _max: { lastSyncedAt: true },
              });
      const lastObservedAt = iso(aggregate._max.lastSyncedAt);
      const rows = await this.prisma.$queryRaw<
        Array<{
          started_at: Date;
          finished_at: Date | null;
          status: string;
          error_count: number;
          last_success_at: Date | null;
        }>
      >`
        SELECT started_at, finished_at, status, error_count,
          (SELECT max(COALESCE(finished_at, started_at)) FROM sync_run WHERE source = ${verb} AND status = 'success') AS last_success_at
        FROM sync_run WHERE source = ${verb} ORDER BY started_at DESC LIMIT 1`;
      const row = rows[0];
      if (!row)
        return {
          state: lastObservedAt ? 'unknown' : 'not_synced',
          lastObservedAt,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastRunStatus: null,
        };
      const lastSuccessAt = iso(row.last_success_at);
      const state =
        row.status === 'error' || row.error_count > 0
          ? 'failed'
          : !lastSuccessAt
            ? 'not_synced'
            : Date.now() - new Date(lastSuccessAt).getTime() > 48 * 3_600_000
              ? 'stale'
              : 'current';
      return {
        state,
        lastObservedAt,
        lastAttemptAt: iso(row.finished_at ?? row.started_at),
        lastSuccessAt,
        lastRunStatus: row.status,
      };
    } catch {
      return {
        state: 'unknown',
        lastObservedAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastRunStatus: null,
      };
    }
  }
}
