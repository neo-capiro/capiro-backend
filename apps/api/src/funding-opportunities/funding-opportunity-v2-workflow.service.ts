import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OpportunitySearchRecordV2, OpportunitySourceV2 } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { readEnabledFundingSources } from './funding-opportunity-source-access.js';
import { readSourceSql } from './funding-opportunity-v2-search.sql.js';
import {
  FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER,
  type OpportunityClientProfileReader,
} from './funding-opportunity-v2-search.service.js';
import { normalizeOpportunitySearchCriteria } from '@capiro/shared';
import { sourceRecordKeyFor, sourceRecordTypeFor } from './funding-opportunity-identity.js';
import { effectiveStage } from './funding-opportunity-pipeline.js';
import { findFundingOpportunityTask, fundingOpportunityTaskSourceId, FUNDING_OPPORTUNITY_TASK_SOURCE, syncExistingFundingActionTask } from './funding-opportunity-task-link.js';


const NOT_FIT_REASONS = {
  capability: 'Outside client capability',
  eligibility: 'Client is not eligible',
  economics: 'Economics do not work',
  capacity: 'No capacity this cycle',
} as const;
export type NotFitReasonV2 = keyof typeof NOT_FIT_REASONS;

type Context = { tenantId: string; userId: string; role?: string };
type WorkflowWriteFields = {
  ownerUserId?: string | null;
  facilityId?: string | null;
  notes?: string | null;
  outcomeNote?: string | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  dismissedReason?: string | null;
};
type SaveStatus = 'saved' | 'pursuing' | 'won' | 'lost' | 'dismissed';
export const V2_ACTION_INTENTS = ['review', 'pursuit'] as const;
export type V2ActionIntent = (typeof V2_ACTION_INTENTS)[number];

@Injectable()
export class FundingOpportunityV2WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER)
    private readonly profiles: OpportunityClientProfileReader,
  ) {}

  async save(
    context: Context,
    source: string,
    sourceRecordId: string,
    clientId: string | null,
    status: SaveStatus = 'saved',
    fields: WorkflowWriteFields = {},
  ) {
    const target = await this.readTarget(context, source, sourceRecordId, clientId);
    if (clientId == null) {
      if (status !== 'saved') throw new BadRequestException('A workspace bookmark can only be saved.');
      const bookmark = await this.prisma.withTenant(context.tenantId, (tx) =>
        this.upsertBookmarkInTransaction(tx, context, null, target.source, target.recordType, target.recordKey ?? target.sourceRecordId),
      );
      return { saved: true, bookmark };
    }
    if (status === 'pursuing') this.assertPursuable(target.record, target.profile);
    const result = await this.prisma.withTenant(context.tenantId, async (tx) => {
      const workflow = await this.writeWorkflowInTransaction(tx, context, clientId, target, status, fields);
      const bookmark = await this.upsertBookmarkInTransaction(tx, context, clientId, target.source, target.recordType, target.recordKey ?? target.sourceRecordId);
      return { workflow, bookmark };
    });
    // Preserve the legacy workflow-shaped save response while adding the
    // explicit bookmark result. Consumers that already read `status`, `notes`,
    // or `owner` do not have to learn a new nesting shape.
    return { ...result.workflow, saved: true, workflow: result.workflow, bookmark: result.bookmark };
  }

  async patch(context: Context, clientId: string, source: string, sourceRecordId: string, input: WorkflowWriteFields & { status?: SaveStatus }) {
    const target = await this.readTarget(context, source, sourceRecordId, clientId);
    const status = input.status ?? 'saved';
    if (status === 'pursuing') this.assertPursuable(target.record, target.profile);
    const { status: requestedStatus, ...fields } = input;
    return this.prisma.withTenant(context.tenantId, async (tx) => {
      const before = await tx.clientFundingOpportunity.findFirst({ where: this.workflowWhere(context, clientId, target), select: { humanDecision: true, workflowStatus: true } });
      const workflow = await this.writeWorkflowInTransaction(tx, context, clientId, target, requestedStatus ?? 'saved', fields);
      const intent = before?.humanDecision === 'pursue' || requestedStatus === 'pursuing' ? 'pursuit' : 'review';
      await syncExistingFundingActionTask(tx, {
        tenantId: context.tenantId,
        clientId,
        source: target.source,
        sourceRecordId: target.sourceRecordId,
        recordType: target.recordType,
        intent,
        ...(fields.ownerUserId !== undefined ? { ownerUserId: fields.ownerUserId } : {}),
        ...(fields.nextAction !== undefined ? { nextAction: fields.nextAction } : {}),
        ...(fields.nextActionDueAt !== undefined ? { nextActionDueAt: fields.nextActionDueAt ? new Date(fields.nextActionDueAt) : null } : {}),
      });
      return workflow;
    });
  }

  async unsave(context: Context, source: string, sourceRecordId: string, clientId: string | null) {
    const target = await this.readTarget(context, source, sourceRecordId, clientId);
    await this.prisma.withTenant(context.tenantId, (tx) => tx.opportunityBookmark.deleteMany({
      where: { tenantId: context.tenantId, clientId, source: target.source, sourceRecordType: target.recordType, sourceRecordKey: target.recordKey ?? target.sourceRecordId },
    }));
    if (clientId == null) return { saved: false };
    const workflow = await this.readWorkflow(context, clientId, target);
    return workflow ? { ...workflow, saved: false, workflow } : { saved: false, workflow: null };
  }

  async notFit(context: Context, clientId: string, source: string, sourceRecordId: string, reason: string, note: string | null) {
    if (!(reason in NOT_FIT_REASONS)) throw new BadRequestException('reason must be capability, eligibility, economics, or capacity.');
    const target = await this.readTarget(context, source, sourceRecordId, clientId);
    const description = NOT_FIT_REASONS[reason as NotFitReasonV2];
    const workflow = await this.writeWorkflow(context, clientId, target, 'saved', {
      humanDecision: 'pass', decisionReason: description, decisionNote: note?.trim() || null,
    });
    return { recorded: true, ...workflow, workflow };
  }

  /** Create/reuse the engagement task and record the matching decision in one
   * tenant transaction. The task key is derived from the resolved current
   * source identity; callers cannot supply an alternate identity or idempotency
   * key. */
  async action(
    context: Context,
    clientId: string,
    source: string,
    sourceRecordId: string,
    input: { intent: V2ActionIntent; ownerUserId?: string | null; notes?: string | null; reason?: string | null; nextAction?: string | null; nextActionDueAt?: string | null },
  ) {
    const target = await this.readTarget(context, source, sourceRecordId, clientId);
    if (input.intent === 'pursuit') this.assertPursuable(target.record, target.profile);
    if (input.ownerUserId !== undefined && input.ownerUserId !== null) {
      await this.assertOwnerAssignable(context.tenantId, input.ownerUserId);
    }
    const dueDate = input.nextActionDueAt == null ? null : new Date(input.nextActionDueAt);
    if (dueDate && !Number.isFinite(dueDate.getTime())) throw new BadRequestException('Follow-up date must be a valid ISO date.');
    const taskSourceId = fundingOpportunityTaskSourceId(clientId, target.source, target.sourceRecordId, input.intent, target.recordType);
    const workflowStatus: SaveStatus = input.intent === 'pursuit' ? 'pursuing' : 'saved';
    const humanDecision = input.intent === 'pursuit' ? 'pursue' : 'monitor';
    const title = `${input.intent === 'pursuit' ? 'Pursue' : 'Review'}: ${target.record.title}`.slice(0, 240);
    return this.prisma.withTenant(context.tenantId, async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${clientId}:${taskSourceId}`}, 0))`);
      const existing = await findFundingOpportunityTask(tx, {
        tenantId: context.tenantId,
        clientId,
        source: target.source,
        sourceRecordId: target.sourceRecordId,
        intent: input.intent,
        recordType: target.recordType,
      });
      const task = existing ?? await tx.engagementTask.create({
        data: {
          tenantId: context.tenantId,
          clientId,
          title,
          description: input.notes?.trim() || null,
          ownerUserId: input.ownerUserId ?? null,
          dueDate,
          sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
          sourceId: taskSourceId,
          createdByUserId: context.userId,
        },
        select: { id: true, title: true, ownerUserId: true, dueDate: true },
      });
      const workflow = await this.writeWorkflowInTransaction(tx, context, clientId, target, workflowStatus, {
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
        ...(input.nextActionDueAt !== undefined ? { nextActionDueAt: input.nextActionDueAt } : {}),
        humanDecision,
        decisionReason: input.reason?.trim() || null,
      });
      await syncExistingFundingActionTask(tx, {
        tenantId: context.tenantId,
        clientId,
        source: target.source,
        sourceRecordId: target.sourceRecordId,
        intent: input.intent,
        recordType: target.recordType,
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
        ...(input.nextActionDueAt !== undefined ? { nextActionDueAt: dueDate } : {}),
      });
      const finalTask = await findFundingOpportunityTask(tx, {
        tenantId: context.tenantId,
        clientId,
        source: target.source,
        sourceRecordId: target.sourceRecordId,
        intent: input.intent,
        recordType: target.recordType,
      });
      const responseTask = finalTask ?? task;
      return {
        task: { id: responseTask.id, title: responseTask.title, ownerUserId: responseTask.ownerUserId, dueDate: responseTask.dueDate?.toISOString() ?? null, reused: existing != null },
        decision: humanDecision,
        workflowStatus: workflow.status,
      };
    });
  }

  async pass(context: Context, clientId: string, source: string, sourceRecordId: string, input: { reason?: string | null; nextAction?: string | null; nextActionDueAt?: string | null }) {
    const target = await this.readTarget(context, source, sourceRecordId, clientId);
    const workflow = await this.writeWorkflow(context, clientId, target, 'saved', {
      humanDecision: 'pass',
      decisionReason: input.reason?.trim() || null,
      ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
      ...(input.nextActionDueAt !== undefined ? { nextActionDueAt: input.nextActionDueAt } : {}),
    });
    return { recorded: true, ...workflow, workflow };
  }

  async dismiss(context: Context, clientId: string, source: string, sourceRecordId: string, reason: string | null) {
    const target = await this.readTarget(context, source, sourceRecordId, clientId);
    const workflow = await this.writeWorkflow(context, clientId, target, 'dismissed', { dismissedReason: reason });
    return { ...workflow, workflow };
  }

  async restore(context: Context, clientId: string, source: string, sourceRecordId: string) {
    const target = await this.readTarget(context, source, sourceRecordId, clientId);
    const workflow = await this.writeWorkflow(context, clientId, target, 'saved', {
      humanDecision: null,
      decisionReason: null,
      dismissedReason: null,
    });
    return { ...workflow, workflow };
  }

  private async readTarget(context: Context, source: string, sourceRecordId: string, clientId: string | null) {
    if (!['grants_gov', 'sam_gov', 'agency_forecast', 'dibbs', 'sbir_sttr', 'ca_portal'].includes(source))
      throw new NotFoundException('Opportunity not found.');
    const sourceValue = source as OpportunitySourceV2;
    if (!(await readEnabledFundingSources(this.prisma, context.tenantId)).includes(sourceValue)) throw new NotFoundException('Opportunity not found.');
    let profile = null;
    if (clientId) {
      const visible = await this.profiles.visibleClientIds({ tenantId: context.tenantId, userId: context.userId });
      if (!visible.includes(clientId)) throw new NotFoundException('Client not found.');
      profile = await this.profiles.read({ tenantId: context.tenantId, userId: context.userId }, clientId);
      if (!profile) throw new NotFoundException('Client not found.');
    }
    const criteria = normalizeOpportunitySearchCriteria({ mode: 'all', clientId: clientId ?? undefined, sources: [sourceValue], lifecycle: [], page: 1, pageSize: sourceValue === 'sbir_sttr' ? 2 : 1 }).criteria;
    const result = await readSourceSql(this.prisma, sourceValue, criteria, profile, sourceRecordId.trim());
    if (sourceValue === 'sbir_sttr' && result.records.length > 1) throw new BadRequestException('This SBIR identifier is ambiguous across topic and solicitation records.');
    const record = result.records[0];
    if (!record) throw new NotFoundException('Opportunity not found.');
    const recordType = sourceRecordTypeFor(sourceValue, record.sourceFacts);
    return { source: sourceValue, sourceRecordId: record.sourceRecordId, recordType, recordKey: sourceRecordKeyFor(sourceValue, record.sourceRecordId, recordType), record, profile };
  }

  private assertPursuable(record: OpportunitySearchRecordV2, profile: unknown): void {
    if (record.lifecycle === 'forecast' || record.lifecycle === 'closed' || !record.isPursuable)
      throw new BadRequestException(record.lifecycle === 'forecast' ? 'A forecast has no response path.' : record.lifecycle === 'closed' ? 'This opportunity is closed, so it cannot be pursued.' : 'This opportunity has no current response path.');
    if (record.clientCapability?.state === 'ineligible') throw new BadRequestException('This client is not eligible to pursue the opportunity as lead applicant.');
    if (!profile) throw new BadRequestException('A visible client is required before pursuit can be evaluated.');
  }

  private async assertOwnerAssignable(tenantId: string, userId: string): Promise<void> {
    const owner = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { id: userId, memberships: { some: { tenantId, status: 'active' } } }, select: { id: true } }),
    );
    if (!owner) throw new NotFoundException('Owner not found.');
  }

  private async upsertBookmarkInTransaction(tx: Prisma.TransactionClient, context: Context, clientId: string | null, source: string, sourceRecordType: string, sourceRecordKey: string) {
    const where = { tenantId: context.tenantId, clientId, source, sourceRecordType, sourceRecordKey };
    const rows = clientId == null
      ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "opportunity_bookmarks"
            ("tenant_id", "client_id", "source", "source_record_type", "source_record_key", "created_by")
          VALUES (${context.tenantId}::uuid, NULL, ${source}, ${sourceRecordType}, ${sourceRecordKey}, ${context.userId}::uuid)
          ON CONFLICT ("tenant_id", "source", "source_record_type", "source_record_key")
          WHERE "client_id" IS NULL DO NOTHING
          RETURNING "id"
        `)
      : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "opportunity_bookmarks"
            ("tenant_id", "client_id", "source", "source_record_type", "source_record_key", "created_by")
          VALUES (${context.tenantId}::uuid, ${clientId}::uuid, ${source}, ${sourceRecordType}, ${sourceRecordKey}, ${context.userId}::uuid)
          ON CONFLICT ("tenant_id", "client_id", "source", "source_record_type", "source_record_key")
          WHERE "client_id" IS NOT NULL DO NOTHING
          RETURNING "id"
        `);
    return rows[0] ? tx.opportunityBookmark.findUnique({ where: { id: rows[0].id } }) : tx.opportunityBookmark.findFirst({ where });
  }

  private workflowWhere(context: Context, clientId: string, target: { source: string; sourceRecordId: string; recordType: string; recordKey?: string }) {
    const generic = { source: target.source, sourceRecordType: target.recordType, sourceRecordKey: target.recordKey ?? target.sourceRecordId };
    if (target.source === 'grants_gov') return { tenantId: context.tenantId, clientId, OR: [{ grantOpportunityId: target.sourceRecordId }, generic] };
    if (target.source === 'sam_gov') return { tenantId: context.tenantId, clientId, OR: [{ samOpportunityId: target.sourceRecordId }, generic] };
    return { tenantId: context.tenantId, clientId, ...generic };
  }

  private async readWorkflow(context: Context, clientId: string, target: { source: string; sourceRecordId: string; recordType: string; recordKey?: string }) {
    return this.prisma.withTenant(context.tenantId, async (tx) => {
      const row = await tx.clientFundingOpportunity.findFirst({ where: this.workflowWhere(context, clientId, target) });
      if (!row) return null;
      const owner = row.ownerUserId ? await tx.user.findUnique({ where: { id: row.ownerUserId }, select: { id: true, firstName: true, lastName: true, email: true } }) : null;
      const facility = row.facilityId ? await tx.clientFacility.findFirst({ where: { id: row.facilityId, tenantId: context.tenantId, clientId }, select: { id: true, name: true, state: true, congressionalDistrict: true } }) : null;
      return this.shapeWorkflow(row, owner, facility);
    });
  }

  private async writeWorkflow(
    context: Context,
    clientId: string,
    target: { source: OpportunitySourceV2; sourceRecordId: string; recordType: string; recordKey?: string; record: OpportunitySearchRecordV2 },
    status: SaveStatus,
    extra: WorkflowWriteFields & { humanDecision?: string | null; decisionReason?: string | null; decisionNote?: string | null } = {},
  ) {
    return this.prisma.withTenant(context.tenantId, (tx) =>
      this.writeWorkflowInTransaction(tx, context, clientId, target, status, extra),
    );
  }

  private async writeWorkflowInTransaction(
    tx: Prisma.TransactionClient,
    context: Context,
    clientId: string,
    target: { source: OpportunitySourceV2; sourceRecordId: string; recordType: string; recordKey?: string; record: OpportunitySearchRecordV2 },
    status: SaveStatus,
    extra: WorkflowWriteFields & { humanDecision?: string | null; decisionReason?: string | null; decisionNote?: string | null } = {},
  ) {
    // Serialize the read/create/update for one exact tenant/client/source key.
    // This avoids an aborted transaction when two first saves race the
    // workflow unique index; bookmark insertion uses ON CONFLICT below.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${clientId}:${target.source}:${target.recordType}:${target.recordKey ?? target.sourceRecordId}`}, 0))`);
    if (extra.ownerUserId !== undefined && extra.ownerUserId !== null) {
      const owner = await tx.user.findFirst({ where: { id: extra.ownerUserId, memberships: { some: { tenantId: context.tenantId, status: 'active' } } }, select: { id: true } });
      if (!owner) throw new NotFoundException('Owner not found.');
    }
    if (extra.facilityId !== undefined && extra.facilityId !== null) {
      const facility = await tx.clientFacility.findFirst({ where: { id: extra.facilityId, tenantId: context.tenantId, clientId }, select: { id: true } });
      if (!facility) throw new NotFoundException('Facility not found for this client.');
    }
      const where = this.workflowWhere(context, clientId, target);
      const existing = await tx.clientFundingOpportunity.findFirst({ where });
      const effectiveExistingStage = existing ? effectiveStage(existing).stage : null;
      if ((status === 'pursuing' || extra.humanDecision === 'pursue') && existing && (['won', 'lost', 'dismissed', 'expired'].includes(existing.workflowStatus) || ['won', 'lost', 'passed'].includes(effectiveExistingStage ?? '') || existing.humanDecision === 'pass')) throw new ConflictException('Restore or reopen this record before pursuing it.');
      const data = {
        // Bookmarking is independent from workflow. A re-save must not turn a
        // pursuit, qualified/submitted stage, win, loss, or pass into `saved`.
        ...(existing && status === 'saved' ? {} : { workflowStatus: status }),
        userCreated: true as const, updatedBy: context.userId,
        ...(extra.humanDecision ? { humanDecision: extra.humanDecision, decisionReason: extra.decisionReason ?? null, decisionAt: new Date(), decisionByUserId: context.userId } : {}),
        ...(extra.decisionNote?.trim() ? { notes: extra.decisionNote.trim() } : {}),
        ...(extra.ownerUserId !== undefined ? { ownerUserId: extra.ownerUserId } : {}),
        ...(extra.facilityId !== undefined ? { facilityId: extra.facilityId } : {}),
        ...(extra.notes !== undefined ? { notes: extra.notes } : {}),
        ...(extra.outcomeNote !== undefined ? { outcomeNote: extra.outcomeNote } : {}),
        ...(extra.nextAction !== undefined ? { nextAction: extra.nextAction } : {}),
        ...(extra.nextActionDueAt !== undefined ? { nextActionDueAt: extra.nextActionDueAt ? new Date(extra.nextActionDueAt) : null } : {}),
        ...(extra.dismissedReason !== undefined ? { dismissedReason: extra.dismissedReason } : {}),
      };
      const row = existing ? await tx.clientFundingOpportunity.update({ where: { id: existing.id }, data }) : await tx.clientFundingOpportunity.create({ data: {
        tenantId: context.tenantId, clientId, source: target.source, grantOpportunityId: target.source === 'grants_gov' ? target.sourceRecordId : null, samOpportunityId: target.source === 'sam_gov' ? target.sourceRecordId : null,
        sourceRecordType: target.recordType, sourceRecordKey: target.recordKey ?? target.sourceRecordId, evidenceSourceType: 'user_action', createdBy: context.userId, ...data,
      } });
      await tx.auditLog.create({ data: {
        tenantId: context.tenantId,
        actorUserId: context.userId,
        action: extra.humanDecision === 'pass'
          ? 'funding_opportunity.not_fit'
          : extra.humanDecision
            ? `funding_opportunity.decision.${extra.humanDecision}`
            : `funding_opportunity.workflow.${status}`,
        entityType: 'client_funding_opportunity',
        entityId: row.id,
        before: (existing ? {
          tenantId: context.tenantId,
          clientId,
          workflowStatus: existing.workflowStatus,
          humanDecision: existing.humanDecision,
          pipelineStage: existing.pipelineStage,
          pipelineStageVersion: existing.pipelineStageVersion,
        } : undefined) as Prisma.InputJsonValue | undefined,
        after: {
          tenantId: context.tenantId,
          clientId,
          workflowStatus: row.workflowStatus,
          humanDecision: row.humanDecision,
          pipelineStage: row.pipelineStage,
          pipelineStageVersion: row.pipelineStageVersion,
          reason: extra.decisionReason ?? null,
          note: extra.decisionNote ?? null,
          source: target.source,
          sourceRecordType: target.recordType,
          sourceRecordKey: target.recordKey ?? target.sourceRecordId,
          sourceRecordId: target.sourceRecordId,
          decision: extra.humanDecision ?? null,
        } as Prisma.InputJsonValue,
      } });
      const owner = row.ownerUserId ? await tx.user.findUnique({ where: { id: row.ownerUserId }, select: { id: true, firstName: true, lastName: true, email: true } }) : null;
      const facility = row.facilityId ? await tx.clientFacility.findFirst({ where: { id: row.facilityId, tenantId: context.tenantId, clientId }, select: { id: true, name: true, state: true, congressionalDistrict: true } }) : null;
      return this.shapeWorkflow(row, owner, facility);
  }

  private shapeWorkflow(row: {
    id: string; workflowStatus: string; ownerUserId: string | null; facilityId: string | null; notes: string | null;
    nextAction: string | null; nextActionDueAt: Date | null; dismissedReason: string | null;
    outcomeNote: string | null; userCreated: boolean; staleAt: Date | null; createdAt: Date; updatedAt: Date;
  }, owner: { id: string; firstName: string | null; lastName: string | null; email: string } | null = null, facility: { id: string; name: string; state: string | null; congressionalDistrict: string | null } | null = null) {
    return { id: row.id, status: row.workflowStatus, owner: row.ownerUserId ? { userId: row.ownerUserId, name: owner ? [owner.firstName, owner.lastName].filter(Boolean).join(' ') || null : null, email: owner?.email ?? null } : null, facility: row.facilityId ? (facility ? { id: facility.id, name: facility.name, state: facility.state, districtKey: facility.state && facility.congressionalDistrict ? `${facility.state.trim().toUpperCase()}-${facility.congressionalDistrict.trim().padStart(2, '0')}` : null } : { id: row.facilityId, name: '', state: null, districtKey: null }) : null, nextAction: row.nextAction ?? null, nextActionDueAt: row.nextActionDueAt?.toISOString() ?? null, notes: row.notes ?? null, dismissedReason: row.dismissedReason ?? null, outcomeNote: row.outcomeNote ?? null, userCreated: row.userCreated, staleAt: row.staleAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
}

export { NOT_FIT_REASONS };