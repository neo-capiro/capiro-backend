import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { bootstrapConversation } from '../meri/meri-conversation-bootstrap.js';
import { OutreachStateRepository } from '../outreach-v3/persistence/outreach-state.repository.js';
import {
  parseCampaignSpecV1,
  hashCampaignSpecV1,
} from '../outreach-v3/state/outreach-campaign-spec.v1.js';
import { OutreachContextReferenceService } from '../capabilities/context/outreach-context-reference.service.js';
import { OutreachTargetReferenceService } from '../capabilities/targets/outreach-target-reference.service.js';
import { prepareOutreachV3ContextForGeneration } from '../outreach-v3/generation/outreach-v3-generation-context.js';
import { EngagementService } from './engagement.service.js';
import {
  OutreachJobService,
  buildItemResult,
  classifyGenerationItem,
} from './outreach-job.service.js';
import { OutreachDraftService } from './outreach-draft.service.js';
import { OutreachSendIntentService } from './outreach-send-intent.service.js';
import {
  GenerationGatewayService,
  type OutreachSdkPreparation,
  type OutreachSdkOutput,
} from './generation/generation-gateway.service.js';
import { GATEWAY_PROMPT_SPEC_VERSION } from './generation/gateway-prompt.js';
import {
  campaignCreateSchema,
  campaignGenerateSchema,
  campaignSaveSchema,
  outreachCampaignStateSchema,
  parseCampaign,
  expandCampaignUnits,
  type OutreachCampaignState,
  type OutreachGenerationUnit,
} from './outreach-campaign.contract.js';

const pairSchema = z
  .object({ generationJobId: z.string().uuid(), itemId: z.string().uuid() })
  .strict();
const boundSchema = pairSchema
  .extend({ conversationId: z.string().uuid(), requestId: z.string().uuid() })
  .strict();
const completeSchema = boundSchema
  .extend({
    output: z.object({ plan: z.unknown(), draft: z.unknown() }).strict(),
    model: z.string().min(1).max(240),
  })
  .strict();
const failSchema = boundSchema
  .extend({ errorCode: z.enum(['generation_failed', 'generation_unknown']) })
  .strict();
type Workflow = { revision: number; state: OutreachCampaignState; requestKey?: string };
type SdkPublicBinding = Omit<SdkBinding, 'kind' | 'packetId' | 'recipientSnapshot'>;
function publicBinding(binding: SdkBinding): SdkPublicBinding {
  const {
    kind: _kind,
    packetId: _packetId,
    recipientSnapshot: _recipientSnapshot,
    ...value
  } = binding;
  return value;
}
type SdkBinding = OutreachSdkPreparation & {
  generationJobId: string;
  itemId: string;
  conversationId: string;
  clientId: string | null;
  requestId: string;
  generationKey: string;
  revision: number;
  recipientSnapshot: Record<string, unknown>;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function campaignId(ctx: TenantContext, requestKey: string): string {
  const hex = createHash('sha256')
    .update(`outreach:${ctx.tenantId}:${ctx.userId}:${requestKey}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

@Injectable()
export class OutreachCampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    private readonly jobs: OutreachJobService,
    private readonly gateway: GenerationGatewayService,
    private readonly drafts: OutreachDraftService,
    private readonly sends: OutreachSendIntentService,
    private readonly context: OutreachContextReferenceService,
    private readonly targets: OutreachTargetReferenceService,
  ) {}

  async list(ctx: TenantContext, clientId?: string, requestKey?: string) {
    if (requestKey) {
      parseCampaign(z.string().uuid(), requestKey);
      try {
        return [await this.get(ctx, campaignId(ctx, requestKey))];
      } catch (error) {
        if (error instanceof NotFoundException) return [];
        throw error;
      }
    }
    const rows = await this.engagement.listOutreachRecords(ctx, { clientId, limit: '100' });
    return rows
      .filter((row) => ['campaign', 'outbound_campaign', 'follow_up'].includes(row.type))
      .map((row) => this.project(row));
  }

  async get(ctx: TenantContext, id: string) {
    parseCampaign(z.string().uuid(), id);
    try {
      return this.project(await this.engagement.getOutreachRecord(ctx, id));
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      return this.readSession(ctx, id);
    }
  }

  async create(ctx: TenantContext, raw: unknown) {
    const input = parseCampaign(campaignCreateSchema, raw);
    const id = campaignId(ctx, input.requestKey);
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, input.state.clientId);
      const existing = await tx.outreachRecord.findFirst({
        where: { id, tenantId: ctx.tenantId, createdByUserId: ctx.userId, deletedAt: null },
      });
      if (existing) {
        if (
          (object(existing.metadata).workflow as Workflow | undefined)?.requestKey !==
          input.requestKey
        )
          throw new ConflictException('Outreach request key conflicts');
        return;
      }
      await tx.outreachRecord.upsert({
        where: { id },
        create: {
          id,
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          type: 'campaign',
          status: 'draft',
          title: input.state.title,
          clientId: input.state.clientId,
          recipients: json(input.state.recipients),
          recipientCount: input.state.recipients.length,
          lastStep: input.state.lastStep,
          metadata: json({
            workflow: { revision: 1, state: input.state, requestKey: input.requestKey },
          }),
        },
        update: {},
      });
    });
    return this.get(ctx, id);
  }

  async save(ctx: TenantContext, id: string, raw: unknown) {
    const input = parseCampaign(campaignSaveSchema, raw);
    const current = await this.get(ctx, id);
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM outreach_records WHERE id=${id}::uuid AND tenant_id=${ctx.tenantId}::uuid FOR UPDATE`;
      const record = await tx.outreachRecord.findFirst({
        where: { id, tenantId: ctx.tenantId, createdByUserId: ctx.userId, deletedAt: null },
      });
      const metadata = object(record?.metadata);
      const revision = (metadata.workflow as Workflow | undefined)?.revision ?? current.revision;
      if (revision !== input.expectedRevision)
        throw new ConflictException('Campaign changed. Reload before saving.');
      if (record && record.status !== 'draft')
        throw new ConflictException('Sent outreach cannot be edited');
      await this.assertClient(tx, ctx, current.state.clientId);
      await this.assertClient(tx, ctx, input.state.clientId);
      const data = {
        title: input.state.title,
        clientId: input.state.clientId,
        type: 'campaign',
        recipients: json(input.state.recipients),
        recipientCount: input.state.recipients.length,
        lastStep: input.state.lastStep,
        metadata: json({
          ...metadata,
          workflow: { ...object(metadata.workflow), revision: revision + 1, state: input.state },
        }),
      };
      // A saved revision supersedes only unfinished SDK work; retained results stay immutable.
      await tx.outreachJob.updateMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          outreachRecordId: id,
          kind: 'generate',
          status: { in: ['queued', 'running'] },
          params: { path: ['executionOwner'], equals: 'claude-agent-sdk' },
        },
        data: { status: 'canceled', finishedAt: new Date() },
      });
      if (record) await tx.outreachRecord.update({ where: { id }, data });
      else
        await tx.outreachRecord.create({
          data: { ...data, id, tenantId: ctx.tenantId, createdByUserId: ctx.userId },
        });
    });
    return this.get(ctx, id);
  }

  async generate(ctx: TenantContext, id: string, raw: unknown) {
    const input = parseCampaign(campaignGenerateSchema, raw);
    const campaign = await this.get(ctx, id);
    if (campaign.revision !== input.expectedRevision || campaign.revision === 0)
      throw new ConflictException('Save the current campaign before generating');
    if (campaign.status !== 'draft')
      throw new ConflictException('Sent outreach cannot be generated');
    const units = expandCampaignUnits(campaign.state).filter((unit) =>
      input.generationKeys.includes(unit.generationKey),
    );
    if (units.length !== new Set(input.generationKeys).size)
      throw new BadRequestException('Unknown generation unit');
    const artifacts = await this.drafts.listForOutreach(ctx, id);
    const result = await this.jobs.submit(ctx, {
      kind: 'generate',
      requestKey: input.requestKey,
      outreachRecordId: id,
      params: {
        executionOwner: 'claude-agent-sdk',
        revision: campaign.revision,
        state: campaign.state,
        generationKeys: [...input.generationKeys].sort(),
        mode: input.mode,
        instruction: input.instruction ?? null,
      },
      recipients: units.map((unit) => ({
        id: unit.generationKey,
        generationKey: unit.generationKey,
        recipient: unit.recipient,
        baseVersionId:
          artifacts.find((a) => a.generationKey === unit.generationKey)?.current?.id ?? null,
        baseVersion:
          artifacts.find((a) => a.generationKey === unit.generationKey)?.currentVersion ?? 0,
      })),
    });
    return { ...(await this.findJob(ctx, id, input.requestKey))!, deduped: result.deduped };
  }

  async findJob(ctx: TenantContext, id: string, requestKey: string) {
    parseCampaign(z.string().uuid(), requestKey);
    await this.get(ctx, id);
    const job = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachJob.findFirst({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          outreachRecordId: id,
          requestKey,
          kind: 'generate',
        },
        select: { id: true },
      }),
    );
    if (!job) return null;
    const result = await this.jobs.getJob(ctx, job.id);
    return {
      jobId: job.id,
      deduped: true,
      items: result!.items.map((item) => ({
        id: item.id,
        generationKey: item.recipientKey,
        status: item.status,
      })),
    };
  }

  async findSend(ctx: TenantContext, id: string, requestKey: string) {
    parseCampaign(z.string().uuid(), requestKey);
    await this.get(ctx, id);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachSendIntent.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, outreachRecordId: id, requestKey },
        select: { id: true },
      }),
    );
    return row ? this.sends.getIntent(ctx, row.id) : null;
  }

  async claim(ctx: TenantContext, raw: unknown, authHeader?: string): Promise<SdkPublicBinding> {
    const input = parseCampaign(pairSchema, raw);
    const unit = await this.currentUnit(ctx, input.generationJobId, input.itemId);
    const existing = object(unit.item.payload).sdk as SdkBinding | undefined;
    if (['done', 'held', 'failed', 'unknown', 'skipped'].includes(unit.item.status))
      throw new ConflictException('Generation is terminal. Read the retained result.');
    if (existing) return publicBinding(existing);
    if (unit.item.status !== 'sdk_pending')
      throw new ConflictException('Generation cannot be restarted');
    const { request, enrichment } = await this.gatewayInput(ctx, unit, authHeader);
    const prepared = await this.gateway.executeSdk(ctx, request, enrichment, { phase: 'prepare' });
    if (!('kind' in prepared) || prepared.kind !== 'sdk_prepared') {
      await this.jobs.finishSdkUnit(
        ctx,
        unit.job.id,
        unit.item.id,
        'failed',
        buildItemResult(prepared),
        'Generation context is unavailable',
      );
      throw new BadRequestException('Generation context is unavailable; review selected sources');
    }
    if (prepared.prompt.length > 100000 || Buffer.byteLength(prepared.prompt, 'utf8') > 110000)
      throw new BadRequestException(
        'Selected context exceeds the generation limit. Select fewer sources.',
      );
    const conversation = await bootstrapConversation(
      this.prisma,
      ctx,
      {
        schemaVersion: 2,
        requestId: unit.item.id,
        scopeKind: unit.campaign.state.clientId ? 'client' : 'general',
        clientId: unit.campaign.state.clientId,
      },
      async () => ({ email: null }),
      { brand: 'Meri', runtime: 'claude-agent-sdk', purpose: 'outreach_generation' },
    );
    const binding: SdkBinding = {
      ...prepared,
      generationJobId: unit.job.id,
      itemId: unit.item.id,
      conversationId: conversation.conversationId,
      clientId: unit.campaign.state.clientId,
      requestId: unit.item.id,
      generationKey: unit.item.recipientKey,
      revision: unit.campaign.revision,
      recipientSnapshot: request.recipient.snapshot,
    };
    return publicBinding(
      (await this.jobs.bindSdkUnit(ctx, unit.job.id, unit.item.id, {
        ...binding,
      })) as unknown as SdkBinding,
    );
  }

  async read(ctx: TenantContext, raw: unknown, authHeader?: string) {
    const { conversationId } = parseCampaign(
      z.object({ conversationId: z.string().uuid() }).strict(),
      raw,
    );
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachJobItem.findFirst({
        where: {
          tenantId: ctx.tenantId,
          job: { userId: ctx.userId, kind: 'generate' },
          payload: { path: ['sdk', 'conversationId'], equals: conversationId },
        },
        select: { id: true, jobId: true },
      }),
    );
    if (!row) return null;
    const unit = await this.currentUnit(ctx, row.jobId, row.id);
    const { request, enrichment } = await this.gatewayInput(ctx, unit, authHeader);
    const check = await this.gateway.executeSdk(ctx, request, enrichment, { phase: 'prepare' });
    if (!('kind' in check))
      throw new NotFoundException('Selected outreach context is no longer available');
    return publicBinding(object(unit.item.payload).sdk as SdkBinding);
  }

  async complete(ctx: TenantContext, raw: unknown, authHeader?: string) {
    const input = parseCampaign(completeSchema, raw);
    const unit = await this.currentUnit(ctx, input.generationJobId, input.itemId);
    const binding = this.assertBinding(unit.item.payload, input);
    if (['done', 'held', 'failed', 'unknown'].includes(unit.item.status))
      return { status: unit.item.status, result: unit.item.result };
    if (!(await this.jobs.beginSdkCompletion(ctx, unit.job.id, unit.item.id)))
      throw new ConflictException(
        'Generation completion is already in progress or its outcome is unknown',
      );
    try {
      const { request, enrichment } = await this.gatewayInput(ctx, unit, authHeader);
      if (
        binding.recipientSnapshot &&
        !isDeepStrictEqual(binding.recipientSnapshot, request.recipient.snapshot)
      )
        throw new ConflictException('Recipient changed during generation. Start a new generation.');
      request.pinned = {
        provider: 'claude-agent-sdk',
        model: input.model,
        planModel: input.model,
        promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION,
      };
      const result = await this.gateway.executeSdk(ctx, request, enrichment, {
        phase: 'complete',
        output: input.output as OutreachSdkOutput,
        packetId: binding.packetId,
      });
      const status = classifyGenerationItem(result);
      const stored = buildItemResult(result);
      await this.jobs.finishSdkUnit(
        ctx,
        unit.job.id,
        unit.item.id,
        status,
        stored,
        result.error ?? null,
      );
      return { status, result: stored };
    } catch (error) {
      await this.jobs
        .finishSdkUnit(
          ctx,
          unit.job.id,
          unit.item.id,
          'unknown',
          null,
          'Generation outcome is unknown; check draft versions before starting again',
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async fail(ctx: TenantContext, raw: unknown) {
    const input = parseCampaign(failSchema, raw);
    const unit = await this.currentUnit(ctx, input.generationJobId, input.itemId);
    this.assertBinding(unit.item.payload, input);
    const status = input.errorCode === 'generation_unknown' ? 'unknown' : 'failed';
    await this.jobs.finishSdkUnit(ctx, unit.job.id, unit.item.id, status, null, input.errorCode);
    const current = await this.jobs.getSdkUnit(ctx, unit.job.id, unit.item.id);
    return { status: current.item.status, result: current.item.result };
  }

  private async currentUnit(ctx: TenantContext, jobId: string, itemId: string) {
    const unit = await this.jobs.getSdkUnit(ctx, jobId, itemId);
    if (!unit.job.outreachRecordId) throw new NotFoundException('Campaign not found');
    const campaign = await this.get(ctx, unit.job.outreachRecordId);
    if (object(unit.job.params).revision !== campaign.revision)
      throw new ConflictException('Campaign changed after generation was requested');
    return { ...unit, campaign };
  }
  private assertBinding(
    payload: unknown,
    input: { conversationId: string; requestId: string },
  ): SdkBinding {
    const binding = object(payload).sdk as SdkBinding | undefined;
    if (
      !binding ||
      binding.conversationId !== input.conversationId ||
      binding.requestId !== input.requestId
    )
      throw new NotFoundException('Outreach generation binding not found');
    return binding;
  }

  private async gatewayInput(
    ctx: TenantContext,
    unit: Awaited<ReturnType<OutreachCampaignService['currentUnit']>>,
    authHeader?: string,
  ) {
    const state = parseCampaign(outreachCampaignStateSchema, object(unit.job.params).state);
    if (state.templateVersionId)
      throw new BadRequestException('Open the saved template campaign before generating');
    if (state.contextItems.some((item) => item.kind === 'meeting'))
      throw new BadRequestException(
        'Select meeting prep or debrief context instead of a generic meeting',
      );
    const saved = expandCampaignUnits(state).find(
      (entry) => entry.generationKey === unit.item.recipientKey,
    );
    if (!saved) throw new ConflictException('Saved generation unit is unavailable');
    const recipient = await this.resolveRecipient(ctx, saved, state);
    const items = state.contextItems.filter(
      (item) => item.scope === 'all' || item.scope === saved.generationKey,
    );
    const parent = state.recipients.find(
      (entry) =>
        entry.role === 'to' &&
        ((entry.kind === 'list' && saved.generationKey.startsWith(`list:${entry.id}:`)) ||
          (entry.kind === 'group' && saved.generationKey === `group:${entry.id}`)),
    );
    if (parent?.personalNote?.trim())
      items.push({
        id: 'parent-recipient-note',
        kind: 'note',
        scope: saved.generationKey,
        customNoteText: parent.personalNote.trim(),
        noteUse: 'instruction',
      });
    const baseVersionId = object(unit.item.payload).baseVersionId;
    const previous =
      object(unit.job.params).mode === 'improve' && typeof baseVersionId === 'string'
        ? await this.drafts.getVersion(ctx, baseVersionId)
        : null;
    if (object(unit.job.params).mode === 'improve' && !previous)
      throw new BadRequestException('No current draft to improve');
    const result = await this.engagement.prepareOutreachSdkInput(
      ctx,
      {
        outreachRecordId: unit.job.outreachRecordId!,
        clientId: state.clientId ?? undefined,
        templateId: state.templateId ?? '',
        mainIdea: state.mainIdea,
        tone: state.tone,
        direction: state.direction,
        recipients: [recipient],
        audienceKind: saved.generationKey.startsWith('group:') ? 'group' : 'individual',
        contextItems: items,
        ...(previous
          ? {
              existingSubject: previous.subject,
              existingBody: previous.body,
              reviseInstruction: String(object(unit.job.params).instruction ?? ''),
            }
          : {}),
      },
      authHeader,
    );
    Object.assign(result.request, {
      styleSamples: state.styleSamples,
      length: state.length,
      contentSkeleton: state.contentSkeleton,
      expectedCampaignRevision: unit.campaign.revision,
      generationJobId: unit.job.id,
      expectedArtifactVersion: object(unit.item.payload).baseVersion,
    });
    const selections = (state.contextSelections ?? []).filter(
      (selection) =>
        selection.scope.kind === 'campaign' ||
        (selection.scope.kind === 'target' &&
          saved.generationKey === `individual:${selection.scope.targetKey}`) ||
        (selection.scope.kind === 'group' &&
          saved.generationKey === `group:${selection.scope.groupRef}`),
    );
    if (selections.length) {
      const current = await this.context.resolveMany(ctx, selections);
      const prepared = prepareOutreachV3ContextForGeneration(current, current);
      result.request.items.push(...prepared.selectedItems);
      for (const evidence of prepared.serverEvidence) {
        result.enrichment.channels.push({
          sourceType: evidence.sourceType,
          sourceKey: evidence.contextKey,
          title: evidence.title,
          trust: evidence.trust,
          scope: 'all',
          load: async () => evidence.text,
          failureSeverity: 'critical',
          failureCode: 'SOURCE_UNAVAILABLE',
          failureMessage: 'Selected context is unavailable',
          authoritativeAsOf: evidence.authoritativeAsOf,
        });
        result.enrichment.auditLedger.push({
          tool: evidence.sourceType,
          serialized: evidence.text,
          result: { sourceId: evidence.contextKey },
        });
      }
    }
    return result;
  }

  private async resolveRecipient(
    ctx: TenantContext,
    unit: OutreachGenerationUnit,
    state: OutreachCampaignState,
  ) {
    const selected = state.recipients.filter(
      (r) =>
        r.role !== 'to' ||
        unit.generationKey === `individual:${r.id}` ||
        unit.generationKey === `group:${r.id}` ||
        unit.generationKey.startsWith(`list:${r.id}:`),
    );
    const rehydrate = async (contact: OutreachCampaignState['recipients'][number]) => {
      if (!contact.locator) return contact;
      const fresh = await this.targets.resolveOne(ctx, contact.locator);
      if (!fresh.email) throw new BadRequestException('Recipient email is no longer available');
      return {
        ...contact,
        name: fresh.displayName,
        email: fresh.email,
        title: fresh.title ?? undefined,
        office: fresh.organization ?? undefined,
      };
    };
    const recipients: OutreachCampaignState['recipients'] = [];
    for (const original of selected) {
      const recipient = await rehydrate(original);
      if (recipient.members) {
        const members = recipient.members.filter(
          (m) =>
            recipient.kind === 'group' ||
            m.role !== 'to' ||
            unit.generationKey === `list:${recipient.id}:${m.id}`,
        );
        recipient.members = await Promise.all(
          members.map(async (member) => {
            const { kind: _kind, ...fresh } = await rehydrate({ ...member, kind: 'individual' });
            return fresh;
          }),
        );
      }
      recipients.push(recipient);
    }
    const current = expandCampaignUnits({ ...state, recipients }).find(
      (entry) => entry.generationKey === unit.generationKey,
    );
    if (!current) throw new BadRequestException('Recipient unit is no longer available');
    return current.recipient;
  }

  private project(row: {
    id: string;
    status: string;
    title: string;
    clientId: string | null;
    updatedAt: Date;
    metadata: unknown;
    recipients: unknown;
    lastStep: number;
  }) {
    const metadata = object(row.metadata);
    const workflow = metadata.workflow as Workflow | undefined;
    const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    const bounded = (value: unknown, limit: number) =>
      typeof value === 'string' ? value.slice(0, limit) : '';
    const contacts = list(row.recipients).map((raw, index) => {
      const r = object(raw);
      const members = list(r.groupMembers).map((rawMember, memberIndex) => {
        const member = object(rawMember);
        return {
          id: bounded(member.id, 384) || String(memberIndex),
          role: 'to',
          name: bounded(member.name, 240),
          email: bounded(member.email, 320),
        };
      });
      return {
        id: bounded(r.id, 384) || String(index),
        kind: members.length ? 'group' : 'individual',
        role: ['to', 'cc', 'bcc'].includes(String(r.role)) ? r.role : 'to',
        name: bounded(r.name, 240),
        email: bounded(r.email, 320),
        ...(members.length ? { members } : {}),
        cc: list(r.cc)
          .filter(
            (v): v is string => typeof v === 'string' && z.string().email().safeParse(v).success,
          )
          .slice(0, 25),
        bcc: list(r.bcc)
          .filter(
            (v): v is string => typeof v === 'string' && z.string().email().safeParse(v).success,
          )
          .slice(0, 25),
        personalNote: bounded(r.personalNote, 500),
      };
    });
    const legacyNotes = list(metadata.contextPool).flatMap((raw, index) => {
      const note = object(raw),
        text = bounded(note.note, 8000);
      if (!text) return [];
      const scopes = list(note.recipientIds).map((id) => `individual:${String(id)}`);
      return (scopes.length ? scopes : ['all']).map((scope) => ({
        id: `legacy-note:${index}`,
        kind: 'note',
        scope,
        customNoteText: text,
        noteUse: 'fact',
      }));
    });
    const state = workflow
      ? parseCampaign(outreachCampaignStateSchema, workflow.state)
      : outreachCampaignStateSchema.parse({
          title: row.title,
          clientId: row.clientId,
          direction: metadata.direction === 'to-clients' ? 'to-clients' : 'on-behalf',
          templateId: typeof metadata.templateId === 'string' ? metadata.templateId : null,
          mainIdea: bounded(metadata.mainIdea ?? metadata.objective, 8000),
          tone: ['professional', 'friendly', 'formal', 'concise'].includes(String(metadata.tone))
            ? metadata.tone
            : 'professional',
          length: ['short', 'standard', 'long'].includes(String(metadata.length))
            ? metadata.length
            : 'standard',
          recipients: contacts,
          contextItems: legacyNotes,
          styleSamples: [],
          attachmentIds: list(metadata.attachmentIds)
            .filter((v) => z.string().uuid().safeParse(v).success)
            .slice(0, 30),
          sender: {
            connectionId: z.string().uuid().safeParse(metadata.senderConnectionId).success
              ? metadata.senderConnectionId
              : null,
            signature: '',
          },
          lastStep: row.lastStep || 1,
        });
    return {
      id: row.id,
      revision: workflow?.revision ?? 0,
      updatedAt: row.updatedAt.toISOString(),
      status: row.status,
      state,
    };
  }

  private async readSession(ctx: TenantContext, id: string) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const repository = new OutreachStateRepository();
      const session = await repository.getOwnedSession(tx, ctx, id);
      const version = await repository.loadStateVersion(tx, ctx, id, session.currentStateVersion);
      const spec = parseCampaignSpecV1(version.specJsonb);
      if (hashCampaignSpecV1(spec) !== version.specHash)
        throw new ConflictException('Stored campaign state is invalid');
      for (const client of spec.sponsor.clientRefs)
        await this.assertClient(tx, ctx, client.clientId);
      const targets = spec.targeting.selectedTargetRefs.map((target) => ({
        id: target.targetKey,
        kind: 'individual' as const,
        role: 'to' as const,
        name: target.displayName,
        email: target.email ?? '',
        locator: target.locator,
        ...spec.targeting.targetCcBcc?.[target.targetKey],
      }));
      const state = outreachCampaignStateSchema.parse({
        title: session.title ?? spec.goal.topic ?? 'Outreach campaign',
        clientId: spec.sponsor.clientRefs[0]?.clientId ?? null,
        direction: spec.sponsor.kind === 'internal_team' ? 'to-clients' : 'on-behalf',
        templateId: null,
        mainIdea: [
          spec.goal.goal,
          spec.goal.objective,
          spec.goal.topic,
          spec.goal.desiredOutcome,
          spec.goal.ask.text,
          spec.goal.whyNow,
          spec.strategy.campaignAngle,
        ]
          .filter(Boolean)
          .join('\n\n'),
        tone: ['professional', 'friendly', 'formal', 'concise'].includes(spec.strategy.tone ?? '')
          ? spec.strategy.tone
          : 'professional',
        length:
          spec.strategy.length === 'short' || spec.strategy.length === 'long'
            ? spec.strategy.length
            : 'standard',
        recipients:
          spec.delivery.pattern === 'shared_thread'
            ? [
                {
                  id: id,
                  kind: 'group',
                  role: 'to',
                  name: 'Campaign recipients',
                  members: targets.map(({ kind: _kind, ...target }) => target),
                },
              ]
            : targets,
        contextItems: [],
        contextSelections: [
          ...spec.context.requiredPolicyRefs,
          ...spec.context.writingGuidanceRefs,
          ...spec.context.campaignFactRefs,
          ...spec.context.targetSpecificRefs,
          ...spec.context.groupSafeRefs,
        ].map(({ locator, contextClass, scope }) => ({
          locator,
          contextClass,
          scope:
            spec.delivery.pattern === 'shared_thread' && scope.kind === 'group'
              ? { kind: 'group', groupRef: id }
              : scope,
        })),
        styleSamples: spec.styleSamples ?? [],
        contentSkeleton: spec.contentSkeleton ?? null,
        attachmentIds: [],
        sender: { connectionId: null, signature: '' },
        lastStep: 1,
      });
      return {
        id,
        revision: 0,
        updatedAt: session.updatedAt.toISOString(),
        status: session.status === 'active' ? 'draft' : session.status,
        state,
      };
    });
  }

  private async assertClient(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string | null,
  ) {
    if (!clientId) return;
    const client = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
      select: { id: true },
    });
    if (!client || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId)))
      throw new NotFoundException('Client not found');
  }
}
