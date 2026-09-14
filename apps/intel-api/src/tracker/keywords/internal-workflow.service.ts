import {
  Injectable,
  Optional,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HearingRecordWorkflowService } from '../../hearing/hearing-record-workflow.service.js';
import { randomUUID } from 'node:crypto';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import {
  CalendarPreparationService,
  type CalendarScope,
} from '../calendar/calendar-preparation.service.js';
import {
  KeywordRuleService,
  KEYWORD_WORKFLOWS_FEATURE,
  requestKey,
} from './keyword-rule.service.js';
import { object } from '../reports/report-domain.js';
import { hash } from '../folders/folder-tracker.service.js';
type WorkflowInput = {
  template: 'hearing_preparation' | 'added_bill_review' | 'published_review' | 'report_review';
  eventId: string | null;
  folderIds: string[];
  jurisdiction: string;
  sessionKey: string;
  contextHash: string;
  eventRevision: number | null;
  reportId: string | null;
  reportVersion: number | null;
  billId: string | null;
  workflowVersion?: number;
  triggerKey?: string;
};
type WorkflowAction = {
  id: string;
  workflow_id: string | null;
  template: WorkflowInput['template'];
  input_hash: string;
  input: WorkflowInput;
  state: string;
  reason: string | null;
  steps: {
    prefill?: Awaited<ReturnType<CalendarPreparationService['prepare']>>;
    draftId?: string;
    contextItemId?: string;
    reviewUrl?: string;
    recordRunId?: string;
    reportRunId?: string;
  };
  lease_token: string | null;
  attempts: number;
};
@Injectable()
export class InternalWorkflowService {
  constructor(
    readonly rules: KeywordRuleService,
    readonly calendar: CalendarPreparationService,
    @Optional() readonly records?: HearingRecordWorkflowService,
  ) {}
  async authorize(ctx: WorkspaceTenantContext) {
    await this.rules.reports.authorize(ctx, KEYWORD_WORKFLOWS_FEATURE);
  }
  async preview(ctx: WorkspaceTenantContext, body: unknown) {
    await this.authorize(ctx);
    const b = object(body);
    if (
      !['hearing_preparation', 'added_bill_review', 'published_review', 'report_review'].includes(
        String(b.template),
      ) ||
      !Array.isArray(b.folderIds) ||
      !b.folderIds.length ||
      b.folderIds.length > 20 ||
      b.folderIds.some((id) => typeof id !== 'string') ||
      typeof b.jurisdiction !== 'string' ||
      typeof b.sessionKey !== 'string'
    )
      throw new BadRequestException('EXPLICIT_WORKFLOW_SCOPE_REQUIRED');
    const scope = await this.calendar.scope(ctx, {
      folderIds: b.folderIds as string[],
      jurisdiction: b.jurisdiction,
      session: b.sessionKey,
    });
    await this.rules.reports.folders.withActor(ctx, async (tx) => {
      for (const f of scope.folders) await this.rules.folder(tx, ctx, f.id);
    });
    const event = b.eventId ? await this.calendar.publicEvent(String(b.eventId)) : null;
    if (
      ['hearing_preparation', 'published_review'].includes(String(b.template)) &&
      (!event || event.jurisdiction !== b.jurisdiction || event.session !== b.sessionKey)
    )
      throw new BadRequestException('EXACT_EVENT_SESSION_REQUIRED');
    if (event) {
      const agenda = object(event.snapshot).agenda;
      const billIds = Array.isArray(agenda) ? agenda.map((a) => object(object(a).bill).id) : [];
      if (!scope.assignments.some((a) => billIds.includes(a.billId)))
        throw new BadRequestException('NO_SELECTED_TRACKED_BILL_ON_AGENDA');
    }
    if (b.template === 'added_bill_review' && !scope.assignments.some((a) => a.billId === b.billId))
      throw new BadRequestException('CURRENT_FOLDER_MEMBERSHIP_REQUIRED');
    let reportVersion: number | null = null;
    if (b.template === 'report_review')
      await this.rules.reports.folders.withActor(ctx, async (tx) => {
        const r = await this.rules.reports.get(tx, ctx, String(b.reportId ?? ''));
        if (
          r.ownerClerkId !== ctx.clerkUserId ||
          r.folderIds.some((id) => !scope.folders.some((f) => f.id === id))
        )
          throw new ForbiddenException('REPORT_OWNER_SCOPE_REQUIRED');
        reportVersion = r.version;
      });
    let recordBoundary: unknown = null;
    if (b.template === 'published_review') {
      if (!this.records)
        throw new ServiceUnavailableException('PUBLISHED_RECORD_ADAPTER_UNAVAILABLE');
      await this.records.authorize(ctx);
      recordBoundary = (await this.records.source.snapshot(event!.id)).map((r) => [
        r.id,
        r.hash,
        r.evidence.sourceObservationId ?? null,
        r.evidence.currentSourceVersion ?? null,
      ]);
    }
    const input: WorkflowInput = {
      template: b.template as WorkflowInput['template'],
      eventId: event?.id ?? null,
      eventRevision: event?.revision ?? null,
      folderIds: scope.folders.map((f) => f.id),
      jurisdiction: b.jurisdiction,
      sessionKey: b.sessionKey,
      reportId: b.reportId ? String(b.reportId) : null,
      reportVersion,
      billId: b.billId ? String(b.billId) : null,
      contextHash: hash({
        folders: scope.folders,
        assignments: scope.assignments.map((a) => ({
          id: a.id,
          billId: a.billId,
          version: a.version,
        })),
        event: event
          ? {
              id: event.id,
              revision: event.revision,
              status: event.status,
              snapshot: event.snapshot,
            }
          : null,
        recordBoundary,
        reportVersion,
      }),
    };
    return {
      input,
      inputHash: hash(input),
      effects: [
        {
          kind:
            input.template === 'hearing_preparation'
              ? 'private_preparation_draft'
              : 'owner_review_item',
          outbound: false,
        },
      ],
      limits:
        input.template === 'added_bill_review'
          ? ['Retained as a private review item with a link to the tracked bill.']
          : [],
    };
  }
  async enqueue(
    ctx: WorkspaceTenantContext,
    body: unknown,
    trigger?: { id: string; version: number; eventKey: string },
  ) {
    const b = object(body),
      preview = await this.preview(ctx, b.input),
      key = requestKey(b.requestKey);
    if (preview.inputHash !== b.inputHash) throw new ConflictException('WORKFLOW_PREVIEW_CHANGED');
    const frozen = trigger
      ? { ...preview.input, workflowVersion: trigger.version, triggerKey: trigger.eventKey }
      : preview.input;
    const frozenHash = hash(frozen);
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      if (trigger) {
        const active = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM intel_legiwatch_workflow WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${trigger.id} AND version=${trigger.version} AND state='active' FOR SHARE`;
        if (!active.length) throw new ConflictException('WORKFLOW_CHANGED_OR_PAUSED');
      }
      const existing = await tx.$queryRaw<
        WorkflowAction[]
      >`SELECT * FROM intel_legiwatch_workflow_action WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${key}`;
      if (existing[0]) {
        if (existing[0].input_hash !== frozenHash)
          throw new ConflictException('WORKFLOW_REQUEST_KEY_REUSED');
        return existing[0];
      }
      const id = randomUUID();
      await tx.$executeRaw`INSERT INTO intel_legiwatch_workflow_action(id,tenant_id,owner_clerk_id,workflow_id,request_key,template,input_hash,input)
    VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${trigger?.id ?? null},${key},${preview.input.template},${frozenHash},${JSON.stringify(frozen)}::jsonb) ON CONFLICT(tenant_id,owner_clerk_id,request_key) DO NOTHING`;
      const [row] = await tx.$queryRaw<
        WorkflowAction[]
      >`SELECT * FROM intel_legiwatch_workflow_action WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${key}`;
      if (row!.input_hash !== frozenHash)
        throw new ConflictException('WORKFLOW_REQUEST_KEY_REUSED');
      return row!;
    });
  }
  async get(ctx: WorkspaceTenantContext, id: string) {
    await this.authorize(ctx);
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      const [r] = await tx.$queryRaw<
        WorkflowAction[]
      >`SELECT * FROM intel_legiwatch_workflow_action WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
      if (!r) throw new NotFoundException('WORKFLOW_ACTION_NOT_FOUND');
      return r;
    });
  }
  async history(ctx: WorkspaceTenantContext, folderId: string) {
    await this.authorize(ctx);
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      await this.rules.folder(tx, ctx, folderId);
      return tx.$queryRaw<
        WorkflowAction[]
      >`SELECT * FROM intel_legiwatch_workflow_action WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}
    AND input->'folderIds' ? ${folderId} ORDER BY created_at DESC,id DESC LIMIT 100`;
    });
  }
  private async current(ctx: WorkspaceTenantContext, action: WorkflowAction) {
    await this.authorize(ctx);
    if (action.state === 'paused') throw new ConflictException('WORKFLOW_PAUSED');
    if (action.workflow_id) {
      const active = await this.rules.reports.folders.withActor(
        ctx,
        (tx) =>
          tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM intel_legiwatch_workflow WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${action.workflow_id} AND version=${action.input.workflowVersion ?? 0} AND state='active'`,
      );
      if (!active.length) throw new ConflictException('WORKFLOW_PAUSED');
    }
    const preview = await this.preview(ctx, action.input);
    const currentInput = action.workflow_id
      ? {
          ...preview.input,
          workflowVersion: action.input.workflowVersion,
          triggerKey: action.input.triggerKey,
        }
      : preview.input;
    if (hash(currentInput) !== action.input_hash)
      throw new ConflictException('SOURCE_OR_FOLDER_CONTEXT_CHANGED');
    if (action.steps.prefill) {
      const status = await this.calendar.snapshotStatus(
        ctx,
        action.steps.prefill.context.snapshotId as string,
      );
      if (status.stale) throw new ConflictException('PREPARATION_SNAPSHOT_STALE');
    }
  }
  async authorizedPreparation(ctx: WorkspaceTenantContext, id: string) {
    if (process.env.LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED !== 'true')
      throw new ConflictException('INTERNAL_WORKFLOWS_PAUSED');
    const action = await this.get(ctx, id);
    await this.current(ctx, action);
    if (
      action.template !== 'hearing_preparation' ||
      !action.steps.prefill ||
      !['running', 'partial', 'complete'].includes(action.state)
    )
      throw new ConflictException('PREPARATION_NOT_READY');
    return { actionId: id, prefill: action.steps.prefill };
  }
  async execute(ctx: WorkspaceTenantContext, id: string) {
    if (process.env.LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED !== 'true')
      throw new ConflictException('INTERNAL_WORKFLOWS_PAUSED');
    let action = await this.get(ctx, id);
    if (action.state === 'complete') return action;
    await this.current(ctx, action);
    const token = randomUUID();
    const claimed = await this.rules.reports.folders.withActor(
      ctx,
      (
        tx,
      ) => tx.$executeRaw`UPDATE intel_legiwatch_workflow_action SET state='running',lease_token=${token},lease_until=now()+interval '3 minutes',attempts=attempts+1
   WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} AND state IN ('pending','running','partial','failed','held') AND (lease_until IS NULL OR lease_until<now()) AND attempts<5`,
    );
    if (!claimed) return this.get(ctx, id);
    try {
      if (action.template === 'hearing_preparation') {
        if (!action.steps.prefill) {
          const prefill = await this.calendar.prepare(
            ctx,
            action.input.eventId!,
            {
              folderIds: action.input.folderIds,
              jurisdiction: action.input.jurisdiction,
              session: action.input.sessionKey,
            },
            id,
          );
          await this.step(ctx, id, token, { ...action.steps, prefill }, 'partial');
          action = await this.get(ctx, id);
        }
        await this.current(ctx, action);
        const secret = process.env.INTERNAL_SERVICE_SECRET,
          base = process.env.WORKSPACE_BASE_URL;
        if (!secret || !base)
          throw new ServiceUnavailableException('WORKSPACE_SOURCE_ADAPTER_NOT_CONFIGURED');
        const response = await fetch(
          `${base.replace(/\/+$/, '')}/workspace-api/internal/legiwatch/preparations`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
            body: JSON.stringify({
              tenantId: ctx.tenantId,
              ownerId: ctx.clerkUserId,
              actionId: id,
            }),
            signal: AbortSignal.timeout(45000),
          },
        );
        if (!response.ok)
          throw new ServiceUnavailableException('WORKSPACE_PREPARATION_RETRY_REQUIRED');
        const result = (await response.json()) as {
          draftId: string;
          contextItemId: string;
          state: string;
        };
        if (
          result.state !== 'complete' ||
          typeof result.draftId !== 'string' ||
          !result.draftId ||
          typeof result.contextItemId !== 'string'
        )
          throw new ServiceUnavailableException('WORKSPACE_OUTPUT_ID_REQUIRED');
        await this.step(
          ctx,
          id,
          token,
          { ...action.steps, draftId: result.draftId, contextItemId: result.contextItemId },
          'complete',
        );
      } else if (action.template === 'published_review') {
        await this.current(ctx, action);
        if (process.env.LEGIWATCH_RECORD_RECONCILIATION_ENABLED !== 'true' || !this.records)
          throw new ConflictException('PUBLISHED_RECORD_RECONCILIATION_PAUSED');
        const run = await this.records.reconcile(ctx, action.input.eventId!, { claims: [] });
        await this.step(
          ctx,
          id,
          token,
          {
            recordRunId: run.id,
            reviewUrl: `/legiwatch/hearings/${encodeURIComponent(action.input.eventId!)}?recordRun=${encodeURIComponent(run.id)}`,
          },
          'complete',
        );
      } else if (action.template === 'report_review') {
        await this.current(ctx, action);
        const run = await this.rules.reports.generate(
          ctx,
          action.input.reportId!,
          {
            cutoff: new Date().toISOString().slice(0, 10),
            audience: 'external',
            expectedVersion: action.input.reportVersion,
          },
          new Date(),
          'phase6:' + id,
        );
        await this.step(
          ctx,
          id,
          token,
          {
            reportRunId: run.id,
            reviewUrl: `/legiwatch?tab=settings&reportView=reports&reportId=${encodeURIComponent(action.input.reportId!)}&reportRun=${encodeURIComponent(run.id)}`,
          },
          'complete',
        );
      } else {
        // The existing tenant-wide task list is not a qualified private sink.
        // Retain a durable owner-scoped review with an existing protected deep link.
        const i = action.input;
        const reviewUrl =
          i.template === 'report_review'
            ? `/legiwatch?tab=settings&reportView=reports&reportId=${encodeURIComponent(i.reportId!)}`
            : i.eventId
              ? `/legiwatch/hearings/${encodeURIComponent(i.eventId)}`
              : `/legiwatch?tab=bills&folder=${encodeURIComponent(i.folderIds[0]!)}&jurisdiction=${i.jurisdiction}&session=${encodeURIComponent(i.sessionKey)}`;
        await this.step(ctx, id, token, { reviewUrl }, 'complete', 'PRIVATE_REVIEW_ITEM');
      }
      return this.get(ctx, id);
    } catch (e) {
      await this.rules.reports.folders.withActor(
        ctx,
        (
          tx,
        ) => tx.$executeRaw`UPDATE intel_legiwatch_workflow_action SET state='partial',reason='RECONCILE_SOURCE_KEY_BEFORE_RETRY',lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} AND lease_token=${token}`,
      );
      throw e;
    }
  }
  private async step(
    ctx: WorkspaceTenantContext,
    id: string,
    token: string,
    steps: WorkflowAction['steps'],
    state: string,
    reason: string | null = null,
  ) {
    await this.authorize(ctx);
    if (process.env.LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED !== 'true')
      throw new ConflictException('INTERNAL_WORKFLOWS_PAUSED');
    const complete = ['complete', 'held'].includes(state);
    const changed = await this.rules.reports.folders.withActor(
      ctx,
      (
        tx,
      ) => tx.$executeRaw`UPDATE intel_legiwatch_workflow_action SET steps=${JSON.stringify(steps)}::jsonb,state=${state},reason=${reason},
   lease_token=${complete ? null : token},lease_until=${complete ? null : new Date(Date.now() + 180000)},updated_at=now()
   WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} AND lease_token=${token} AND lease_until>now()`,
    );
    if (!changed) throw new ConflictException('WORKFLOW_LEASE_LOST');
  }
  async pause(ctx: WorkspaceTenantContext, id: string) {
    await this.authorize(ctx);
    return this.rules.reports.folders.withActor(
      ctx,
      (
        tx,
      ) => tx.$executeRaw`UPDATE intel_legiwatch_workflow_action SET state='paused',lease_token=NULL,lease_until=NULL,updated_at=now()
   WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} AND state<>'complete'`,
    );
  }
  async due(tenantId: string) {
    if (process.env.LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED !== 'true') return { state: 'disabled' };
    const pending = await this.rules.reports.folders.prisma.withSystem(
      (tx) => tx.$queryRaw<
        Array<{ id: string; owner_clerk_id: string }>
      >`SELECT id,owner_clerk_id FROM intel_legiwatch_workflow_action WHERE tenant_id=${tenantId}
   AND state IN ('pending','running','partial','failed') AND attempts<5 AND (lease_until IS NULL OR lease_until<now()) ORDER BY updated_at,id LIMIT 5`,
    );
    const results = [];
    for (const row of pending) {
      try {
        const r = await this.execute(
          { tenantId, clerkUserId: row.owner_clerk_id, role: null },
          row.id,
        );
        results.push({ id: row.id, state: r.state });
      } catch {
        await this.rules.reports.folders.withActor(
          { tenantId, clerkUserId: row.owner_clerk_id, role: null },
          (
            tx,
          ) => tx.$executeRaw`UPDATE intel_legiwatch_workflow_action SET state='held',reason='CURRENT_SOURCE_OWNER_OR_WORKFLOW_REVIEW_REQUIRED',updated_at=now()
          WHERE tenant_id=${tenantId} AND owner_clerk_id=${row.owner_clerk_id} AND id=${row.id} AND state IN ('pending','partial','failed') AND (lease_until IS NULL OR lease_until<now())`,
        );
        results.push({ id: row.id, state: 'held' });
      }
    }
    return { results };
  }
}
