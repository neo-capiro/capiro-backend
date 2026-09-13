import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { InternalWorkflowService } from './internal-workflow.service.js';
import { object } from '../reports/report-domain.js';
import { checkedVersion } from './keyword-rule.service.js';
import { hash } from '../folders/folder-tracker.service.js';

type Workflow = {
  id: string;
  name: string;
  template: string;
  state: string;
  version: number;
  owner_clerk_id: string;
  config: {
    folderIds: string[];
    jurisdiction: string;
    sessionKey: string;
    reportId?: string;
    folderVersions?: Record<string, number>;
  };
  baseline_at: Date;
  cursor: string | null;
};
type Event = {
  event_key: string;
  kind: string;
  hearing_id: string | null;
  observed_at: Date;
  bill_ids: string[];
};
@Injectable()
export class WorkflowTriggerService {
  constructor(readonly actions: InternalWorkflowService) {}
  private get folders() {
    return this.actions.rules.reports.folders;
  }
  async list(ctx: WorkspaceTenantContext, folderId: string) {
    await this.actions.authorize(ctx);
    return this.folders.withActor(ctx, async (tx) => {
      await this.actions.rules.folder(tx, ctx, folderId);
      return tx.$queryRaw<
        Workflow[]
      >`SELECT * FROM intel_legiwatch_workflow WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND config->'folderIds' ? ${folderId} ORDER BY name,id LIMIT 100`;
    });
  }
  async save(ctx: WorkspaceTenantContext, body: unknown, id?: string) {
    await this.actions.authorize(ctx);
    const b = object(body),
      c = object(b.config);
    if (
      typeof b.name !== 'string' ||
      !b.name.trim() ||
      b.name.length > 200 ||
      !['hearing_preparation', 'added_bill_review', 'published_review', 'report_review'].includes(
        String(b.template),
      ) ||
      !Array.isArray(c.folderIds) ||
      !c.folderIds.length ||
      c.folderIds.length > 20 ||
      c.folderIds.some((x) => typeof x !== 'string') ||
      typeof c.jurisdiction !== 'string' ||
      typeof c.sessionKey !== 'string'
    )
      throw new BadRequestException('EXPLICIT_TEMPLATE_SCOPE_REQUIRED');
    const name = String(b.name).trim();
    const config = {
      folderIds: [...new Set(c.folderIds)] as string[],
      jurisdiction: c.jurisdiction,
      sessionKey: c.sessionKey,
      ...(b.template === 'report_review' ? { reportId: String(c.reportId ?? '') } : {}),
    };
    await this.actions.calendar.scope(ctx, { ...config, session: config.sessionKey });
    return this.folders.withActor(ctx, async (tx) => {
      for (const f of config.folderIds.sort()) await this.actions.rules.folder(tx, ctx, f, true);
      if (b.template === 'report_review') {
        const report = await this.actions.rules.reports.get(tx, ctx, config.reportId!);
        if (
          report.ownerClerkId !== ctx.clerkUserId ||
          report.folderIds.some((f) => !config.folderIds.includes(f))
        )
          throw new BadRequestException('REPORT_OWNER_SCOPE_REQUIRED');
      }
      if (id) {
        const n =
          await tx.$executeRaw`UPDATE intel_legiwatch_workflow SET name=${name},template=${String(b.template)},config=${JSON.stringify(config)}::jsonb,version=version+1,state='paused',cursor=NULL,updated_at=now()
     WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} AND version=${checkedVersion(b.expectedVersion)}`;
        if (!n) throw new ConflictException('WORKFLOW_CHANGED_RELOAD');
      } else {
        id = randomUUID();
        await tx.$executeRaw`INSERT INTO intel_legiwatch_workflow(id,tenant_id,owner_clerk_id,name,template,config) VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${name},${String(b.template)},${JSON.stringify(config)}::jsonb)`;
      }
      return (
        await tx.$queryRaw<
          Workflow[]
        >`SELECT * FROM intel_legiwatch_workflow WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`
      )[0];
    });
  }
  async activation(ctx: WorkspaceTenantContext, id: string, body: unknown) {
    await this.actions.authorize(ctx);
    const b = object(body);
    if (typeof b.enabled !== 'boolean')
      throw new BadRequestException('EXPLICIT_ACTIVATION_REQUIRED');
    return this.folders.withActor(ctx, async (tx) => {
      const [row] = await tx.$queryRaw<
        Workflow[]
      >`SELECT * FROM intel_legiwatch_workflow WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} FOR UPDATE`;
      if (!row) throw new NotFoundException();
      if (row.version !== checkedVersion(b.expectedVersion))
        throw new ConflictException('WORKFLOW_CHANGED_RELOAD');
      const folderVersions: Record<string, number> = {};
      if (b.enabled) {
        if (b.baseline !== 'from_now' || b.reviewed !== true)
          throw new BadRequestException('REVIEW_FROM_NOW_REQUIRED');
        for (const f of row.config.folderIds.sort()) {
          const folder = await this.actions.rules.folder(tx, ctx, f, true);
          if (
            !folder.ownerClerkId ||
            !(await this.folders.source.activeMember(ctx.tenantId, folder.ownerClerkId, tx))
          )
            throw new BadRequestException('CURRENT_OWNER_REQUIRED');
          folderVersions[f] = folder.version;
        }
      }
      await tx.$executeRaw`UPDATE intel_legiwatch_workflow SET state=${b.enabled ? 'active' : 'paused'},version=version+1,config=${JSON.stringify({ ...row.config, folderVersions })}::jsonb,
    baseline_at=now(),cursor=NULL,updated_at=now() WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
      return { id, state: b.enabled ? 'active' : 'paused', version: row.version + 1 };
    });
  }
  async detect(tenantId: string, now = new Date()) {
    if (process.env.LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED !== 'true')
      return { state: 'disabled', events: 0 };
    const rows = await this.folders.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Workflow[]
        >`SELECT * FROM intel_legiwatch_workflow WHERE tenant_id=${tenantId} AND state='active' ORDER BY updated_at,id LIMIT 10`,
    );
    const results = [];
    for (const row of rows) {
      const ctx = { tenantId, clerkUserId: row.owner_clerk_id, role: null };
      try {
        await this.actions.authorize(ctx);
        const scope = await this.actions.calendar.scope(ctx, {
          ...row.config,
          session: row.config.sessionKey,
        });
        if (scope.folders.some((f) => row.config.folderVersions?.[f.id] !== f.version))
          throw new ConflictException('FOLDER_CONTEXT_CHANGED');
        let events: Event[];
        if (row.template === 'added_bill_review') {
          events = await this.folders.withActor(
            ctx,
            (tx) => tx.$queryRaw<
              Event[]
            >`SELECT id AS event_key,'assignment'::text AS kind,NULL::text AS hearing_id,created_at AS observed_at,ARRAY[bill_id] AS bill_ids
      FROM intel_legiwatch_decision d WHERE tenant_id=${tenantId} AND folder_id=ANY(${row.config.folderIds}::text[]) AND action='add' AND outcome='added'
      AND created_at>${row.baseline_at} AND created_at<=${now} AND NOT EXISTS(SELECT 1 FROM intel_legiwatch_workflow_seen s WHERE s.tenant_id=${tenantId} AND s.owner_clerk_id=${ctx.clerkUserId} AND s.workflow_id=${row.id} AND s.workflow_version=${row.version} AND s.event_key=d.id)
      ORDER BY created_at,id LIMIT 10`,
          );
        } else {
          events = await this.folders.withActor(
            ctx,
            (tx) => tx.$queryRaw<
              Event[]
            >`SELECT * FROM legiwatch_workflow_source_event e WHERE jurisdiction=${row.config.jurisdiction} AND session_key=${row.config.sessionKey}
      AND kind=${row.template === 'hearing_preparation' ? 'calendar' : 'published'} AND observed_at>${row.baseline_at} AND observed_at<=${now}
      AND NOT EXISTS(SELECT 1 FROM intel_legiwatch_workflow_seen s WHERE s.tenant_id=${tenantId} AND s.owner_clerk_id=${ctx.clerkUserId} AND s.workflow_id=${row.id} AND s.workflow_version=${row.version} AND s.event_key=e.event_key) ORDER BY observed_at,event_key LIMIT 10`,
          );
        }
        for (const e of events) {
          if (scope.assignments.some((a) => e.bill_ids.includes(a.billId))) {
            const input = {
              ...row.config,
              template: row.template,
              eventId: e.hearing_id,
              billId: e.bill_ids.find((id) => scope.billIds.includes(id)),
            };
            try {
              const preview = await this.actions.preview(ctx, input);
              await this.actions.enqueue(
                ctx,
                {
                  input: preview.input,
                  inputHash: preview.inputHash,
                  requestKey: 'trigger:' + hash([row.id, row.version, e.event_key]),
                },
                { id: row.id, version: row.version, eventKey: e.event_key },
              );
            } catch (error) {
              // A removed agenda item remains visible as a held trigger with its exact
              // source identity. It is never silently discarded or turned into a packet.
              await this.folders.withActor(ctx, async (tx) => {
                const [active] = await tx.$queryRaw<
                  Workflow[]
                >`SELECT * FROM intel_legiwatch_workflow WHERE tenant_id=${tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${row.id} AND version=${row.version} AND state='active' FOR SHARE`;
                if (!active) return;
                const retained = {
                  ...input,
                  workflowVersion: row.version,
                  triggerKey: e.event_key,
                };
                await tx.$executeRaw`INSERT INTO intel_legiwatch_workflow_action(id,tenant_id,owner_clerk_id,workflow_id,request_key,template,input_hash,input,state,reason)
         VALUES(${randomUUID()},${tenantId},${ctx.clerkUserId},${row.id},${'trigger:' + hash([row.id, row.version, e.event_key])},${row.template},${hash(retained)},${JSON.stringify(retained)}::jsonb,'held','SOURCE_OR_SCOPE_REVIEW_REQUIRED') ON CONFLICT DO NOTHING`;
              });
            }
          }
          await this.folders.withActor(ctx, async (tx) => {
            await tx.$executeRaw`INSERT INTO intel_legiwatch_workflow_seen(tenant_id,owner_clerk_id,workflow_id,workflow_version,event_key,observed_at)
             VALUES(${tenantId},${ctx.clerkUserId},${row.id},${row.version},${e.event_key},${e.observed_at}) ON CONFLICT DO NOTHING`;
          });
          await this.folders.withActor(
            ctx,
            (
              tx,
            ) => tx.$executeRaw`UPDATE intel_legiwatch_workflow SET cursor=${JSON.stringify({ at: e.observed_at.toISOString(), key: e.event_key })},updated_at=now()
      WHERE tenant_id=${tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${row.id} AND version=${row.version} AND state='active'`,
          );
        }
        await this.folders.withActor(
          ctx,
          (tx) =>
            tx.$executeRaw`UPDATE intel_legiwatch_workflow SET updated_at=now() WHERE tenant_id=${tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${row.id}`,
        );
        results.push({ id: row.id, events: events.length, state: 'checked' });
      } catch {
        await this.folders.withActor(
          ctx,
          (
            tx,
          ) => tx.$executeRaw`UPDATE intel_legiwatch_workflow SET state='paused',config=jsonb_set(config,'{reviewReason}','"CURRENT_OWNER_OR_SCOPE_REVIEW_REQUIRED"'::jsonb),updated_at=now()
          WHERE tenant_id=${tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${row.id} AND version=${row.version}`,
        );
        results.push({ id: row.id, state: 'held' });
      }
    }
    return { results };
  }
}
