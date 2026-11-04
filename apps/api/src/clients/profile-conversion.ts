import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import { readProfileFacts, writeProfileFact } from './profile-facts.js';
import { MANUAL_FIELDS, type ProfileProjectionService } from './profile-projection.service.js';
import type { ReviewTransaction } from './client-profile-fill-review-store.js';
import { assertSharedProfileEvidence } from './profile-shared-evidence.js';

type SourceRun = { id: string; requestedSources: string[]; status: string };
/** The canonical conversion lock and transaction own facts, resources, and successor work. */
export async function carryProspectProfile(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  prospectId: string,
  clientId: string,
  projection: ProfileProjectionService,
) {
  const subject = { kind: 'client' as const, id: clientId },
    effects: ReviewTransaction['afterCommit'] = [];
  const runs = await tx.$queryRawUnsafe<SourceRun[]>(
    `SELECT id,requested_sources AS "requestedSources",status FROM client_profile_fill_run WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid FOR UPDATE`,
    ctx.tenantId,
    prospectId,
  );
  const active = runs.filter((r) => r.status === 'running');
  if (runs.length) {
    const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM client_profile_fill_run WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND (status='running' OR EXISTS(SELECT 1 FROM client_profile_fill_extension_task e WHERE e.run_id=client_profile_fill_run.id AND e.status IN ('queued','running'))) LIMIT 1`,
      ctx.tenantId,
      clientId,
    );
    if (existing.length)
      throw new ConflictException(
        'The client has active research. Finish or cancel that run before converting this prospect.',
      );
  }
  // Child IDs belong to their original subject. New canonical child owners assign
  // new IDs; the copied fact records that ID while retaining its source origin.
  const facts = await readProfileFacts(tx, ctx.tenantId, { kind: 'prospect', id: prospectId });
  for (const fact of facts.filter((f) => f.isCurrent && f.status === 'approved')) {
    let evidence = fact.evidence,
      sourceUrl = fact.sourceUrl,
      attachmentId = fact.attachmentId;
    try {
      await assertSharedProfileEvidence(
        tx,
        ctx.tenantId,
        { kind: 'prospect', id: prospectId },
        [...evidence, ...(attachmentId ? [{ attachmentId }] : [])],
        ctx,
      );
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      evidence = [
        {
          label: 'Original source is no longer shared',
          sourceUnavailable: true,
          sourceFactId: fact.id,
        },
      ];
      sourceUrl = null;
      attachmentId = null;
    }
    const section = fact.fieldKey.split('.')[0]!,
      isChild = ['locations', 'leadership', 'capabilities', 'notes'].includes(section);
    const value = isChild
      ? Object.fromEntries(Object.entries(asRecord(fact.value)).filter(([key]) => key !== 'id'))
      : fact.value;
    const copied = await writeProfileFact(tx, ctx, subject, {
      fieldKey: fact.fieldKey,
      value,
      origin: fact.origin,
      originId: `prospect:${fact.id}`,
      sourceType: fact.sourceType,
      sourceUrl,
      attachmentId,
      evidence,
      observedAt: fact.observedAt,
      confidence: fact.confidence,
      findingId: fact.findingId,
      runId: fact.runId,
      approvedBy: fact.approvedBy,
      approvedAt: fact.approvedAt,
      preserveCurrent: true,
    });
    if (
      !copied.conflict &&
      (MANUAL_FIELDS.has(fact.fieldKey) ||
        /^(locations|leadership|capabilities|advocacy|notes)\./.test(fact.fieldKey))
    ) {
      const projected = await projection.project(
        { tx, afterCommit: effects },
        ctx,
        subject,
        fact.fieldKey,
        value,
        JSON.parse(
          JSON.stringify(
            (evidence.length ? evidence : [{}]).map((source) => ({
              ...asRecord(source),
              attachmentId: asRecord(asRecord(source).metadata).attachmentId,
              origin: fact.origin,
              sourceFactId: fact.id,
              approvedByUserId: fact.approvedBy,
              approvedAt: fact.approvedAt,
            })),
          ),
        ) as Prisma.InputJsonValue,
      );
      const id = asString(asRecord(projected).id),
        key = isChild && id ? `${section}.${id}` : fact.fieldKey;
      await tx.$executeRawUnsafe(
        `UPDATE profile_fact SET field_key=$3,value_jsonb=$4::jsonb WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        ctx.tenantId,
        copied.fact.id,
        key,
        JSON.stringify(projected),
      );
    }
  }
  const notes = await tx.businessDevelopmentProspectActivity.findMany({
    where: { tenantId: ctx.tenantId, prospectId, kind: 'note' },
    orderBy: { createdAt: 'asc' },
  });
  for (const note of notes) {
    const key = `notes.${note.id}`,
      projected = await projection.project({ tx, afterCommit: effects }, ctx, subject, key, {
        body: note.body,
      });
    await writeProfileFact(tx, ctx, subject, {
      fieldKey: `notes.${asString(asRecord(projected).id) ?? note.id}`,
      value: projected,
      origin: 'person',
      originId: `prospect-note:${note.id}`,
      sourceType: 'prospect_note',
      approvedBy: note.actorUserId,
      approvedAt: note.createdAt,
    });
  }
  await tx.$executeRawUnsafe(
    `INSERT INTO profile_attachment_link(tenant_id,client_id,prospect_id,attachment_id) SELECT tenant_id,$3::uuid,prospect_id,id FROM engagement_attachments WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND superseded_by_attachment_id IS NULL AND lifecycle_status NOT IN ('delete_pending','delete_failed') ON CONFLICT DO NOTHING`,
    ctx.tenantId,
    prospectId,
    clientId,
  );
  const successorRunId = runs.length
    ? await carryResearch(tx, ctx, prospectId, clientId, runs)
    : null;
  for (const run of active) {
    await tx.$executeRawUnsafe(
      `UPDATE client_profile_fill_run SET status='cancelled',stage='cancelled',cancelled_at=now(),completed_at=now(),updated_at=now(),setup_jsonb=setup_jsonb||$3::jsonb WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      ctx.tenantId,
      run.id,
      JSON.stringify({ convertedToClientId: clientId, successorRunId }),
    );
    for (const table of ['client_profile_fill_task', 'client_profile_fill_extension_task'])
      await tx.$executeRawUnsafe(
        `UPDATE ${table} SET status='cancelled',completed_at=now(),worker_id=NULL,updated_at=now() WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status IN ('queued','running')`,
        ctx.tenantId,
        run.id,
      );
  }
  return {
    effects,
    sourceRunIds: runs.map((r) => r.id),
    successorRunId,
    sources: [...new Set(active.flatMap((r) => r.requestedSources))],
  };
}

async function carryResearch(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  prospectId: string,
  clientId: string,
  runs: SourceRun[],
) {
  const activeIds = runs.filter((r) => r.status === 'running').map((r) => r.id);
  const tasks = await tx.$queryRawUnsafe<
    Array<{
      id: string;
      taskType: string;
      taskKey: string;
      input: Record<string, unknown>;
      dependsOn: string[];
    }>
  >(
    `SELECT id,task_type AS "taskType",task_key AS "taskKey",input_jsonb AS input,depends_on AS "dependsOn" FROM client_profile_fill_task WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND run_id=ANY($3::uuid[]) AND status IN ('queued','running')`,
    ctx.tenantId,
    prospectId,
    activeIds,
  );
  const runId = randomUUID(),
    sources = [
      ...new Set(runs.filter((r) => r.status === 'running').flatMap((r) => r.requestedSources)),
    ];
  // Per-task Context Plane and actor rechecks remain the existing worker's owner.
  // Queue insertion commits with conversion, so a process crash cannot lose work.
  await tx.$executeRawUnsafe(
    `INSERT INTO client_profile_fill_run(id,tenant_id,client_id,created_by_user_id,status,stage,requested_sources,source_states_jsonb,workflow_version,setup_jsonb,attachment_ids,last_progress_at,completed_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::text[],'{}',2,$8::jsonb,$9::uuid[],now(),$10)`,
    runId,
    ctx.tenantId,
    clientId,
    ctx.userId,
    tasks.length ? 'running' : 'completed',
    tasks.length ? 'research' : 'completed',
    sources,
    JSON.stringify({
      convertedFromProspectId: prospectId,
      sourceRunIds: runs.map((r) => r.id),
      pendingReviewCarried: true,
    }),
    tasks.map((t) => asString(t.input.attachmentId)).filter(Boolean),
    tasks.length ? null : new Date(),
  );
  const ids = new Map(tasks.map((t) => [t.id, randomUUID()]));
  for (const task of tasks)
    await tx.$executeRawUnsafe(
      `INSERT INTO client_profile_fill_task(id,run_id,tenant_id,client_id,task_type,task_key,status,depends_on,input_jsonb,max_attempts) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,'queued',$7::uuid[],$8::jsonb,3)`,
      ids.get(task.id),
      runId,
      ctx.tenantId,
      clientId,
      task.taskType,
      `converted:${task.id}:${task.taskKey}`,
      task.dependsOn.flatMap((id) => (ids.get(id) ? [ids.get(id)!] : [])),
      JSON.stringify({
        ...task.input,
        ...(task.taskType === 'client_document' ? { sourceProspectId: prospectId } : {}),
      }),
    );
  const findings = await tx.$queryRawUnsafe<Array<{ id: string; evidence: unknown[] }>>(
    `SELECT id,evidence_jsonb AS evidence FROM client_profile_fill_finding WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid ORDER BY created_at`,
    ctx.tenantId,
    prospectId,
  );
  let omitted = 0;
  for (const finding of findings) {
    try {
      await assertSharedProfileEvidence(
        tx,
        ctx.tenantId,
        { kind: 'prospect', id: prospectId },
        finding.evidence,
      );
    } catch {
      omitted++;
      continue;
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO client_profile_fill_finding(run_id,tenant_id,client_id,kind,target_key,source,fact_kind,current_value_jsonb,proposed_value_jsonb,evidence_jsonb,confidence,status,content_hash,reviewed_by,reviewed_at,rejection_reason,applied_at) SELECT $3::uuid,tenant_id,$4::uuid,kind,target_key,source,fact_kind,current_value_jsonb,proposed_value_jsonb,evidence_jsonb||$5::jsonb,confidence,status,content_hash,reviewed_by,reviewed_at,rejection_reason,applied_at FROM client_profile_fill_finding WHERE tenant_id=$1::uuid AND id=$2::uuid ON CONFLICT(run_id,content_hash) DO NOTHING`,
      ctx.tenantId,
      finding.id,
      runId,
      clientId,
      JSON.stringify([
        {
          label: 'Carried from converted prospect',
          source: 'prospect_conversion',
          metadata: { prospectId, sourceFindingId: finding.id },
        },
      ]),
    );
  }
  await tx.$executeRawUnsafe(
    `UPDATE client_profile_fill_run SET setup_jsonb=setup_jsonb||$3::jsonb WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    ctx.tenantId,
    runId,
    JSON.stringify({ unavailableSourceFindingCount: omitted }),
  );
  return runId;
}
