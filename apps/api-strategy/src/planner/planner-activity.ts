import type { PlannerEvent, PlannerTimeDetails } from '@capiro/strategy-verifier';
import {
  Prisma,
  type SpPlannerEvent,
  type SpPlannerEventRevision,
} from '../../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
type Tx = Prisma.TransactionClient;

export function plannerStoredTime(
  row: SpPlannerEvent,
  revision?: SpPlannerEventRevision,
): PlannerTimeDetails {
  const original = (row.details as Record<string, unknown>)?.time;
  const corrected = (revision?.details as Record<string, unknown> | undefined)?.time;
  return {
    workedOn: row.createdAt.toISOString().slice(0, 10),
    timeZone: 'UTC',
    billable: false,
    projectId: row.projectId,
    category: '',
    ...(original as Partial<PlannerTimeDetails> | undefined),
    ...(corrected as Partial<PlannerTimeDetails> | undefined),
  };
}

export function plannerEventView(
  row: SpPlannerEvent,
  revision?: SpPlannerEventRevision,
): PlannerEvent {
  const removed = revision?.removed ?? false;
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    ...(row.resourceId ? { resourceId: row.resourceId } : {}),
    actorId: row.actorId,
    ...(row.kind === 'budget_threshold' && (row.details as Record<string, unknown>)?.budgetThreshold
      ? {
          budgetThreshold: {
            projectId: String(
              ((row.details as Record<string, unknown>).budgetThreshold as Record<string, unknown>)
                .projectId,
            ),
          },
        }
      : {}),
    ...((row.details as Record<string, unknown>)?.timesheet
      ? {
          timesheet: (row.details as Record<string, unknown>)
            .timesheet as PlannerEvent['timesheet'],
        }
      : {}),
    ...(row.kind === 'time' ? { time: plannerStoredTime(row, revision) } : {}),
    kind: row.kind as PlannerEvent['kind'],
    text: removed ? '' : (revision?.text ?? row.text),
    minutes: removed ? null : (revision?.minutes ?? row.minutes),
    createdAt: row.createdAt.toISOString(),
    version: revision?.version ?? 0,
    editedAt: revision?.createdAt.toISOString() ?? null,
    editedBy: revision?.actorId ?? null,
    ...((row.details as Record<string, unknown>)?.recordedBy
      ? { recordedBy: String((row.details as Record<string, unknown>).recordedBy) }
      : {}),
    removed,
  };
}
export async function plannerReadActivity(
  tx: Tx,
  ctx: AuthTenantContext,
  rows: SpPlannerEvent[],
): Promise<PlannerEvent[]> {
  if (!rows.length) return [];
  const revisions = await tx.$queryRaw<SpPlannerEventRevision[]>`
    SELECT r.id, r.tenant_id AS "tenantId", r.event_id AS "eventId",
      r.actor_id AS "actorId", r.version, r.text, r.minutes, r.removed, r.details, r.created_at AS "createdAt"
    FROM unnest(ARRAY[${Prisma.join(rows.map((e) => Prisma.sql`${e.id}::uuid`))}]::uuid[]) AS ids(event_id)
    JOIN LATERAL (SELECT * FROM sp_planner_event_revisions
      WHERE tenant_id = ${ctx.tenantId}::uuid AND event_id = ids.event_id
      ORDER BY version DESC LIMIT 1) r ON true`;
  const latest = new Map(revisions.map((r) => [r.eventId, r]));
  return rows.map((row) => plannerEventView(row, latest.get(row.id)));
}
export async function plannerActualMinutes(
  tx: Tx,
  ctx: AuthTenantContext,
  taskIds: string[],
): Promise<Map<string, number>> {
  if (!taskIds.length) return new Map();
  const rows = await tx.$queryRaw<{ taskId: string; minutes: number }[]>`
    SELECT e.task_id AS "taskId", SUM(CASE WHEN COALESCE(r.removed, false) THEN 0
      ELSE COALESCE(r.minutes, e.minutes, 0) END)::double precision AS minutes
    FROM sp_planner_events e
    LEFT JOIN LATERAL (
      SELECT minutes, removed FROM sp_planner_event_revisions
      WHERE tenant_id = ${ctx.tenantId}::uuid AND event_id = e.id
      ORDER BY version DESC LIMIT 1
    ) r ON true
    WHERE e.tenant_id = ${ctx.tenantId}::uuid AND e.kind = 'time'
      AND e.task_id IN (${Prisma.join(taskIds.map((id) => Prisma.sql`${id}::uuid`))})
    GROUP BY e.task_id`;
  return new Map(rows.map((row) => [row.taskId, Number(row.minutes)]));
}
